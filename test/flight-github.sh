#!/usr/bin/env bash
# Tests for bin/flight-github. Each test runs the script against a local bare
# repo, with a stub `gh` first on PATH that records its arguments.
#
#   bash test/flight-github.sh

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/bin/flight-github"
FAILED=0
PASSED=0

setup() {
	TMP=$(mktemp -d)
	git init -q --bare -b main "$TMP/origin.git"
	git clone -q "$TMP/origin.git" "$TMP/work" 2>/dev/null
	cd "$TMP/work" || exit 1
	git config user.email test@example.com
	git config user.name Test
	git commit -q --allow-empty -m base
	git push -q origin main

	mkdir "$TMP/stub"
	cat >"$TMP/stub/gh" <<-'STUB'
		#!/usr/bin/env bash
		printf '%s\n' "$*" >>"$GH_LOG"
		if [ "$1 $2" = "pr create" ]; then
			echo "https://github.com/example/repo/pull/7"
		fi
	STUB
	chmod +x "$TMP/stub/gh"
	export GH_LOG="$TMP/gh.log"
	: >"$GH_LOG"
	export PATH="$TMP/stub:$PATH"
}

teardown() {
	cd "$ROOT" || exit 1
	rm -rf "$TMP"
}

# run <args...>: runs the script, keeping its output in $OUT and status in $STATUS.
run() {
	OUT=$("$SCRIPT" "$@" 2>&1)
	STATUS=$?
}

# refused: the run failed and said why, rather than failing for another reason.
refused() {
	[ "$STATUS" -ne 0 ] || return 1
	case "$OUT" in *"flight-github: refused:"*) return 0 ;; esac
	return 1
}

fail() {
	echo "  $1"
	echo "  output: $OUT"
	return 1
}

remote_sha() {
	git --git-dir="$TMP/origin.git" rev-parse --verify --quiet "refs/heads/$1"
}

on_issue_branch_with_a_commit() {
	git switch -q -c "flight-deck/$1"
	echo fix >fix.txt
	git add fix.txt
	git commit -q -m fix
}

test_push_sends_the_issue_branch_to_origin() {
	on_issue_branch_with_a_commit SHA-12
	run push SHA-12
	[ "$STATUS" -eq 0 ] || fail "exit $STATUS" || return 1
	[ "$(remote_sha flight-deck/SHA-12)" = "$(git rev-parse HEAD)" ] || fail "origin lacks the branch" || return 1
}

test_push_refuses_on_the_default_branch() {
	echo change >change.txt
	git add change.txt
	git commit -q -m change
	before=$(remote_sha main)
	run push SHA-12
	refused || fail "push on main succeeded" || return 1
	[ "$(remote_sha main)" = "$before" ] || fail "main moved on origin" || return 1
	[ -z "$(remote_sha flight-deck/SHA-12)" ] || fail "pushed a branch from main" || return 1
}

test_push_refuses_when_the_issue_branch_is_the_default_branch() {
	git --git-dir="$TMP/origin.git" branch flight-deck/SHA-12 main
	git --git-dir="$TMP/origin.git" symbolic-ref HEAD refs/heads/flight-deck/SHA-12
	on_issue_branch_with_a_commit SHA-12
	before=$(remote_sha flight-deck/SHA-12)
	run push SHA-12
	refused || fail "pushed to the default branch" || return 1
	[ "$(remote_sha flight-deck/SHA-12)" = "$before" ] || fail "default branch moved" || return 1
}

test_push_refuses_when_origins_default_branch_is_unreadable() {
	git --git-dir="$TMP/origin.git" symbolic-ref HEAD refs/heads/missing
	on_issue_branch_with_a_commit SHA-12
	run push SHA-12
	refused || fail "pushed without knowing the default branch" || return 1
	[ -z "$(remote_sha flight-deck/SHA-12)" ] || fail "origin has the branch" || return 1
}

test_push_refuses_another_issues_branch() {
	on_issue_branch_with_a_commit SHA-12
	run push SHA-13
	refused || fail "pushed while on another issue's branch" || return 1
	[ -z "$(remote_sha flight-deck/SHA-13)" ] || fail "origin has SHA-13" || return 1
	[ -z "$(remote_sha flight-deck/SHA-12)" ] || fail "origin has SHA-12" || return 1
}

test_push_never_rewrites_a_pushed_commit() {
	on_issue_branch_with_a_commit SHA-12
	run push SHA-12
	pushed=$(remote_sha flight-deck/SHA-12)
	[ -n "$pushed" ] || fail "the first push failed" || return 1
	git commit -q --amend -m rewritten
	run push SHA-12
	[ "$STATUS" -ne 0 ] || fail "a rewritten branch was pushed" || return 1
	[ "$(remote_sha flight-deck/SHA-12)" = "$pushed" ] || fail "origin's commit was replaced" || return 1
}

test_push_sends_no_tags_under_follow_tags() {
	on_issue_branch_with_a_commit SHA-12
	git tag -a v9 -m unreleased
	git config push.followTags true
	run push SHA-12
	[ "$STATUS" -eq 0 ] || fail "exit $STATUS" || return 1
	[ -z "$(git --git-dir="$TMP/origin.git" tag)" ] || fail "origin got tags: $(git --git-dir="$TMP/origin.git" tag)" || return 1
}

test_push_refuses_a_malformed_identifier() {
	git switch -q -c "flight-deck/main"
	run push main
	refused || fail "accepted 'main' as an issue" || return 1
}

test_open_makes_a_draft_pull_request_into_the_default_branch() {
	on_issue_branch_with_a_commit SHA-12
	run push SHA-12
	echo "The body." >"$TMP/body.md"
	run open SHA-12 --title "Fix the thing" --body-file "$TMP/body.md"
	[ "$STATUS" -eq 0 ] || fail "exit $STATUS" || return 1
	case "$OUT" in *"/pull/7"*) ;; *) fail "no pull request URL printed" || return 1 ;; esac
	expected="pr create --repo $TMP/origin.git --draft --base main --head flight-deck/SHA-12 --title Fix the thing --body-file $TMP/body.md"
	[ "$(cat "$GH_LOG")" = "$expected" ] || fail "gh got: $(cat "$GH_LOG")" || return 1
}

test_open_refuses_a_branch_origin_lacks() {
	on_issue_branch_with_a_commit SHA-12
	echo "The body." >"$TMP/body.md"
	run open SHA-12 --title "Fix the thing" --body-file "$TMP/body.md"
	refused || fail "opened a pull request for an unpushed branch" || return 1
	[ ! -s "$GH_LOG" ] || fail "gh was called: $(cat "$GH_LOG")" || return 1
}

test_open_needs_a_title_and_a_body() {
	on_issue_branch_with_a_commit SHA-12
	run push SHA-12
	run open SHA-12 --title "Fix the thing"
	refused || fail "opened without a body" || return 1
	[ ! -s "$GH_LOG" ] || fail "gh was called: $(cat "$GH_LOG")" || return 1
}

test_ready_marks_the_issue_branchs_pull_request_ready() {
	run ready SHA-12
	[ "$STATUS" -eq 0 ] || fail "exit $STATUS" || return 1
	[ "$(cat "$GH_LOG")" = "pr ready --repo $TMP/origin.git flight-deck/SHA-12" ] || fail "gh got: $(cat "$GH_LOG")" || return 1
}

test_an_unknown_action_is_refused() {
	run merge SHA-12
	refused || fail "accepted 'merge'" || return 1
	[ ! -s "$GH_LOG" ] || fail "gh was called: $(cat "$GH_LOG")" || return 1
}

for test in $(declare -F | awk '{print $3}' | grep '^test_'); do
	if [ $# -gt 0 ] && [ "$test" != "$1" ]; then continue; fi
	setup
	if "$test"; then
		PASSED=$((PASSED + 1))
		echo "ok   $test"
	else
		FAILED=$((FAILED + 1))
		echo "FAIL $test"
	fi
	teardown
done

echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
