#!/bin/sh
# PostToolUse: format the file Claude just edited; exit 2 sends Biome's errors back to Claude.
f=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tool_input?.file_path??""))')
[ -z "$f" ] && exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
./node_modules/.bin/biome check --write --no-errors-on-unmatched --files-ignore-unknown=true "$f" >&2 || exit 2
