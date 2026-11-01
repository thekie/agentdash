#!/bin/sh
# Formats the file that an edit changed. Exit status 2 sends the errors from Biome back to the agent.
f=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tool_input?.file_path??""))')
[ -z "$f" ] && exit 0
# Biome crashes on a path outside the repository instead of skipping it.
case "$f" in "$CLAUDE_PROJECT_DIR"/*) ;; *) exit 0 ;; esac
cd "$CLAUDE_PROJECT_DIR" || exit 0
./node_modules/.bin/biome check --write --no-errors-on-unmatched --files-ignore-unknown=true "$f" >&2 || exit 2
