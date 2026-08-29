#!/usr/bin/env bash
# Deterministic mock `crw` binary for the test suite. No network, no real crw.
# Behavior is driven by env: MOCK_MODE, ARGS_FILE.
#   (unset)   -> valid JSON for scrape/search/map
#   slow      -> sleep 5s then valid JSON (drives abort + timeout)
#   huge      -> emit >5MB to stdout (drives truncation cap, M3)
#   fail      -> stderr "boom" + exit 1 (drives non-zero exit)
#   argecho   -> record argv to $ARGS_FILE, then valid JSON

cmd="$1"
all="$*"

if [ -n "$ARGS_FILE" ]; then
	printf '%s\n' "$all" >"$ARGS_FILE"
fi

case "$MOCK_MODE" in
slow)
	sleep 5
	;;
huge)
	yes x | head -c 6291456
	exit 0
	;;
fail)
	echo "boom: simulated crw failure" >&2
	exit 1
	;;
esac

if [ "$cmd" = "scrape" ]; then
	# `-f text` returns raw plain text on stdout, not JSON (matches the real CLI).
	case "$all" in
	*"-f text"*)
		printf '%s' 'Example Domain plain text body'
		;;
	*)
		printf '%s' '{"markdown":"# Example Domain\nmock","metadata":{"statusCode":200},"creditCost":1}'
		;;
	esac
elif [ "$cmd" = "search" ]; then
	printf '%s' '[{"url":"https://tokio.rs","title":"Tokio","description":"async","position":1}]'
elif [ "$cmd" = "map" ]; then
	printf '%s' '{"success":true,"links":["https://example.com/","https://example.com/docs"],"sitemaps":[]}'
else
	echo "mock-crw 0.0.0"
fi
