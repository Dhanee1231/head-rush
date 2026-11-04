---
name: test-runner
description: Runs Head Rush's browser test suites and reports failures. Use after any code change.
tools: Bash, Read
---
From the repo root, run this exact line on its own:

cos-box sh -c 'for t in tests/*.mjs; do node "$t" check || echo "FAILED: $t"; done'

Report each suite's result and, for any failure, its error, briefly. Don't change any files. If Chrome or puppeteer-core is missing, say that the test environment isn't set up rather than reporting a test failure.
