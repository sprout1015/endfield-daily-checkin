"""
Endfield 개발 로그 자동화 — develop 브랜치 커밋을 읽어 Claude(Anthropic API)로 한국어 초안을
작성하고 Notion "📕 Library" DB에 상태="초안" 페이지로 게시한다.

RAGDeck의 scripts/notion_devlog.py를 이식한 것으로, 프로젝트명·카테고리 태그만 다르다.
GitHub Actions(.github/workflows/notion-devlog.yml)의 push(develop) 트리거에서 자동 실행되며,
로컬에서도 동일하게 실행 가능(--dry-run/--skip-notion으로 비용·부작용 없이 검증).

커밋 범위 자동 판별: HEAD가 병합 커밋(부모 2개, 이 레포의 --no-ff 컨벤션)이면 HEAD^1..HEAD,
아니면(develop 직접 커밋 허용 케이스) HEAD~1..HEAD. GitHub 이벤트의 before/after에 의존하지 않아
새 브랜치·force-push edge case에도 흔들리지 않는다.
"""
import argparse
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8")  # cp949 콘솔 대응
except Exception:
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "../.env"))

import anthropic
import requests

RECORD_SEP = "\x1e"
FIELD_SEP = "\x1f"

DEFAULT_DATABASE_ID = "2d50b3188d248070846ae76c6ed1a108"  # 📕 Library
CATEGORY_TAG = "Endfield Extension 개발로그"

SYSTEM_PROMPT = """당신은 Endfield 출석 자동화 프로젝트의 개발 로그 작성자입니다.
주어진 커밋 로그·변경 파일 통계만을 근거로 한국어 개발 로그 초안을 작성하세요.
커밋·문서에 없는 내용은 절대 창작하지 마세요. 불확실하면 "확인 필요"로 표기하세요.

출력은 반드시 아래 마크다운 구조를 그대로 따르세요(다른 텍스트 없이 이 구조만 출력):

## 요약
(1~3줄) 이 기간 핵심 변경 요약

## 변경 사항
(커밋/주제별) 무엇이 바뀌었나 — 왜 — 관련 파일·커밋 SHA(짧게)

## 영향 범위
영향받는 모듈/기능, 하위호환·마이그레이션 필요 여부

## 검증
테스트 상태(커밋 메시지 근거). 미확인이면 "확인 필요"로 표기

## 남은 과제 · 다음 단계
TODO, 후속 작업

커밋을 언급할 때는 짧은 SHA(예: abc1234)만 쓰고 마크다운 링크(`[텍스트](url)`)나 URL을
직접 만들지 마세요 — 실제 GitHub 링크는 하단에 자동으로 추가됩니다."""


def _git(*args, cwd=None):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                             encoding="utf-8", check=True)
    return result.stdout.strip()


def _repo_root():
    return _git("rev-parse", "--show-toplevel")


def _merge_parents(root, sha):
    """sha가 병합 커밋(부모 2개 이상)이면 parent SHA 목록[parent1, parent2, ...]을 반환, 아니면 None."""
    parents = _git("rev-list", "--parents", "-1", sha, cwd=root).split()
    return parents[1:] if len(parents) >= 3 else None


def resolve_range(root, from_sha=None, to_sha=None):
    """(from_sha, to_sha) 명시 시 그대로. 아니면 HEAD 병합 커밋 부모 기준 자동 판별."""
    if from_sha and to_sha:
        return from_sha, to_sha
    to_sha = to_sha or "HEAD"
    parents = _merge_parents(root, to_sha)
    if parents:
        return parents[0], to_sha
    return f"{to_sha}~1", to_sha


def gather_commits(root, from_sha, to_sha):
    fmt = f"%H{FIELD_SEP}%an{FIELD_SEP}%ad{FIELD_SEP}%s{FIELD_SEP}%b{RECORD_SEP}"
    raw = _git("log", "--no-merges", f"--pretty=format:{fmt}", "--date=short",
               f"{from_sha}..{to_sha}", cwd=root)
    commits = []
    for record in filter(None, raw.split(RECORD_SEP)):
        parts = record.strip("\n").split(FIELD_SEP)
        if len(parts) >= 4:
            commits.append({
                "sha": parts[0], "author": parts[1], "date": parts[2],
                "subject": parts[3], "body": parts[4] if len(parts) > 4 else "",
            })
    return commits


def gather_diff_stat(root, from_sha, to_sha):
    return _git("diff", "--stat", f"{from_sha}..{to_sha}", cwd=root)


_SUBTITLE_MAX_LEN = 60


def extract_subtitle(root, to_sha, commits):
    """제목에 붙일 가벼운 부제. to_sha가 병합 커밋일 때만 그 body 첫 줄(GitHub가 자동으로
    넣는 PR 제목)을 쓴다 — 병합 커밋이 아니면 첫 커밋 subject로 대체한다."""
    subtitle = ""
    if _merge_parents(root, to_sha):
        try:
            body = _git("log", "-1", "--pretty=%b", to_sha, cwd=root)
        except subprocess.CalledProcessError:
            body = ""
        subtitle = next((line.strip() for line in body.splitlines() if line.strip()), "")
    if not subtitle and commits:
        subtitle = commits[0]["subject"]
    if len(subtitle) > _SUBTITLE_MAX_LEN:
        subtitle = subtitle[:_SUBTITLE_MAX_LEN - 1].rstrip() + "…"
    return subtitle


def build_title(to_sha_date: str, subtitle: str, commit_count: int) -> str:
    base = f"Endfield 개발로그 {to_sha_date}"
    if subtitle:
        base += f" — {subtitle}"
    if commit_count > 1:
        base += f" ({commit_count}건)"
    return base


def build_prompt(commits, diff_stat, from_sha, to_sha):
    commit_lines = "\n\n".join(
        f"- {c['sha'][:8]} ({c['date']}, {c['author']}): {c['subject']}"
        + (f"\n  {c['body'].strip()}" if c["body"].strip() else "")
        for c in commits
    )
    parts = [
        f"커밋 범위: {from_sha[:8]}..{to_sha[:8]}\n",
        f"## 커밋 목록\n{commit_lines or '(없음)'}\n",
        f"## 변경 파일 통계\n{diff_stat or '(없음)'}\n",
    ]
    return "\n".join(parts)


def draft_devlog(prompt: str, model: str = "claude-opus-4-8") -> str:
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    response = client.messages.create(
        model=model,
        max_tokens=4096,
        system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text.strip()


_NOTION_TEXT_LIMIT = 2000  # Notion rich_text.content 최대 길이
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


def rich_text(text: str, link: str = None) -> list:
    """일반 텍스트를 Notion rich_text 배열로 변환. `**볼드**`를 실제 bold annotation으로 변환.
    link가 주어지면 전체 텍스트가 하이퍼링크가 된다. 2000자 제한은 각 구간 내에서 청크 분할."""
    if link:
        chunks = [text[i:i + _NOTION_TEXT_LIMIT] for i in range(0, len(text), _NOTION_TEXT_LIMIT)] or [""]
        return [{"type": "text", "text": {"content": c, "link": {"url": link}}} for c in chunks]

    segments = []  # (text, is_bold)
    pos = 0
    for m in _BOLD_RE.finditer(text):
        if m.start() > pos:
            segments.append((text[pos:m.start()], False))
        segments.append((m.group(1), True))
        pos = m.end()
    if pos < len(text) or not segments:
        segments.append((text[pos:], False))

    result = []
    for seg_text, bold in segments:
        chunks = [seg_text[i:i + _NOTION_TEXT_LIMIT] for i in range(0, len(seg_text), _NOTION_TEXT_LIMIT)] or [""]
        for chunk in chunks:
            entry = {"type": "text", "text": {"content": chunk}}
            if bold:
                entry["annotations"] = {"bold": True}
            result.append(entry)
    return result


def markdown_to_blocks(markdown: str) -> list:
    """최소 변환: '## '=heading_2, '- '/'* '=bulleted_list_item, 나머지 연속 줄=paragraph."""
    blocks = []
    paragraph_buf = []

    def flush_paragraph():
        if paragraph_buf:
            blocks.append({
                "object": "block", "type": "paragraph",
                "paragraph": {"rich_text": rich_text(" ".join(paragraph_buf))},
            })
            paragraph_buf.clear()

    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
        elif stripped.startswith("## "):
            flush_paragraph()
            blocks.append({
                "object": "block", "type": "heading_2",
                "heading_2": {"rich_text": rich_text(stripped[3:].strip())},
            })
        elif stripped.startswith("- ") or stripped.startswith("* "):
            flush_paragraph()
            blocks.append({
                "object": "block", "type": "bulleted_list_item",
                "bulleted_list_item": {"rich_text": rich_text(stripped[2:].strip())},
            })
        else:
            paragraph_buf.append(stripped)
    flush_paragraph()
    return blocks


def cap_blocks(blocks: list) -> list:
    """Notion children 100개 제한. 조용히 자르지 않고 경고를 출력한다."""
    if len(blocks) > 100:
        print(f"경고: 블록 {len(blocks)}개 중 100개만 게시됨 (Notion children 제한, 뒷부분 잘림)")
        return blocks[:100]
    return blocks


def repo_web_url(root: str) -> str:
    """git remote(origin)에서 GitHub 웹 URL 도출 (SSH/HTTPS 형식 모두 처리)."""
    remote = _git("remote", "get-url", "origin", cwd=root)
    remote = remote.rstrip("/")
    if remote.endswith(".git"):
        remote = remote[:-4]
    if remote.startswith("git@"):
        host_path = remote.split("@", 1)[1].replace(":", "/", 1)
        return f"https://{host_path}"
    return remote


def extract_pr_number(root: str, to_sha: str):
    """to_sha가 '--no-ff' 병합 커밋이면 그 subject에서 PR 번호를 추출."""
    try:
        subject = _git("log", "-1", "--pretty=%s", to_sha, cwd=root)
    except subprocess.CalledProcessError:
        return None
    m = re.search(r"Merge pull request #(\d+)", subject)
    return m.group(1) if m else None


def build_link_blocks(repo_url: str, pr_number, commits: list) -> list:
    """PR·커밋 링크를 결정적으로(LLM 개입 없이) 생성 — 하이퍼링크가 실제로 동작하도록."""
    if not pr_number and not commits:
        return []
    blocks = [{
        "object": "block", "type": "heading_2",
        "heading_2": {"rich_text": rich_text("관련 링크")},
    }]
    if pr_number:
        url = f"{repo_url}/pull/{pr_number}"
        blocks.append({
            "object": "block", "type": "bulleted_list_item",
            "bulleted_list_item": {"rich_text": rich_text(f"PR #{pr_number}", link=url)},
        })
    for c in commits:
        url = f"{repo_url}/commit/{c['sha']}"
        label = f"{c['sha'][:8]} — {c['subject']}"
        blocks.append({
            "object": "block", "type": "bulleted_list_item",
            "bulleted_list_item": {"rich_text": rich_text(label, link=url)},
        })
    return blocks


def create_notion_page(database_id: str, title: str, blocks: list) -> str:
    token = os.getenv("NOTION_DEVLOG_TOKEN")
    if not token:
        raise RuntimeError("NOTION_DEVLOG_TOKEN 환경변수가 없습니다.")
    today = datetime.now(timezone.utc).date().isoformat()
    payload = {
        "parent": {"database_id": database_id},
        "properties": {
            "문서 이름": {"title": [{"text": {"content": title}}]},
            "카테고리": {"multi_select": [{"name": CATEGORY_TAG}]},
            "상태": {"select": {"name": "초안"}},
            "날짜": {"date": {"start": today}},
        },
        "children": blocks,
    }
    resp = requests.post(
        "https://api.notion.com/v1/pages",
        headers={
            "Authorization": f"Bearer {token}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30,
    )
    if not resp.ok:
        print(f"Notion API 오류 응답 ({resp.status_code}): {resp.text}")
    resp.raise_for_status()
    return resp.json()["url"]


def main():
    parser = argparse.ArgumentParser(description="Endfield 커밋 → Notion 개발 로그 초안 생성")
    parser.add_argument("--from-sha", default=None)
    parser.add_argument("--to-sha", default=None)
    parser.add_argument("--dry-run", action="store_true",
                         help="네트워크 호출 없이 git 수집·블록 변환만 확인")
    parser.add_argument("--skip-notion", action="store_true",
                         help="Anthropic은 실제 호출하되 Notion 쓰기는 생략")
    # 미등록 repo variable(vars.X)은 빈 문자열("")로 전달되므로 `or`로 빈 문자열도 default로 폴백.
    parser.add_argument("--database-id", default=os.getenv("NOTION_DEVLOG_DATABASE_ID") or DEFAULT_DATABASE_ID)
    args = parser.parse_args()

    root = _repo_root()
    from_sha, to_sha = resolve_range(root, args.from_sha, args.to_sha)
    print(f"커밋 범위: {from_sha[:8]}..{to_sha[:8]}")

    commits = gather_commits(root, from_sha, to_sha)
    print(f"커밋 {len(commits)}개 발견")
    if not commits:
        print("새 커밋이 없어 종료합니다.")
        return

    diff_stat = gather_diff_stat(root, from_sha, to_sha)
    prompt = build_prompt(commits, diff_stat, from_sha, to_sha)
    subtitle = extract_subtitle(root, to_sha, commits)
    title = build_title(datetime.now(timezone.utc).date().isoformat(), subtitle, len(commits))

    if args.dry_run:
        print("--dry-run: 아래는 stub 초안이며 실제 Anthropic 호출 없음")
        draft = "## 요약\n(dry-run stub)\n\n## 변경 사항\n(dry-run stub)"
    else:
        print("Anthropic 호출 중...")
        draft = draft_devlog(prompt)
        if not draft.strip():
            raise RuntimeError("Anthropic이 빈 초안을 반환했습니다 — 빈 Notion 페이지 생성을 막기 위해 중단합니다.")

    repo_url = repo_web_url(root)
    pr_number = extract_pr_number(root, to_sha)
    blocks = cap_blocks(markdown_to_blocks(draft) + build_link_blocks(repo_url, pr_number, commits))
    print(f"블록 {len(blocks)}개 생성"
          + (f" (PR #{pr_number} 링크 포함)" if pr_number else ""))
    print("--- 초안 미리보기 ---")
    print(draft[:500])
    print("---")

    if args.dry_run or args.skip_notion:
        print("Notion 쓰기 생략됨 (--dry-run/--skip-notion)")
        return

    print("Notion 페이지 생성 중...")
    url = create_notion_page(args.database_id, title, blocks)
    print(f"완료: {url}")


if __name__ == "__main__":
    main()
