# Notice

brigadev-harness is an independent project. Its workflow design is adapted from:

- **gentle-shell / gentle-pi** by Gentleman Programming — https://github.com/Gentleman-Programming/gentle-shell
  (MIT License; its skills declare Apache-2.0). The ODD workflow, task sizing, high-risk list,
  delegation triggers, agent roles, 4R lenses, Judgment Day protocol, and delivery skills are
  rewritten and simplified from that project's prompts and skills. Model routing profiles and
  claude-bridge list-price accounting follow its agent-model profiles and bridge-cost designs.
- **Pi subagent example** from `@earendil-works/pi-coding-agent` — the subagent process runner in
  `extensions/subagents.ts` is adapted from `examples/extensions/subagent`.

"Gentle", "gentle-shell", and "el Gentleman" are names of their respective owners and are not used
as branding here.

## Third-party license notices

### gentle-shell

Source: https://github.com/Gentleman-Programming/gentle-shell (commit 7ecb826a2b1eafa6b522ee16d905a99e998f0c89).
Its `LICENSE` file, reproduced verbatim:

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Pi (`@earendil-works/pi-coding-agent`)

The subagent runner adapts Pi's `examples/extensions/subagent`. Pi is published under the MIT License
(per its `package.json`); the same MIT permission notice above applies to that portion.
