// The web UI's markdown subset, as a pure parser: text in, a tree of plain objects out. The page turns the tree into DOM
// nodes with textContent and never builds HTML, so nothing an agent writes can become markup.
// Classic script (inlined into index.html by extensions/web-ui.ts) and importable by tests: it sets globalThis.brigadevMarkdown.
//
// Blocks: { t: "p" | "quote", c } · { t: "h", level, c } · { t: "code", lang, text } · { t: "hr" }
//         { t: "ul" | "ol", start?, items: [{ check: null | boolean, c }] } · { t: "table", head: [c], rows: [[c]] }
// Inline: { t: "text", v } · { t: "code", v } · { t: "b" | "i", c } · { t: "a", href, c } (http and https only)
(function (root) {
	"use strict";

	var FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
	var HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
	var RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
	var QUOTE = /^\s{0,3}>\s?(.*)$/;
	var ITEM = /^\s*([-*+]|(\d{1,9})[.)])\s+(.*)$/;
	var TASK = /^\[([ xX])\]\s+(.*)$/;
	var TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
	var PUNCT = /[!-\/:-@\[-`{-~]/;
	var WORD = /[\p{L}\p{N}]/u;

	function isBlank(line) { return !line || !line.trim(); }
	function isTableStart(lines, i) {
		return i + 1 < lines.length && lines[i].indexOf("|") >= 0 && lines[i + 1].indexOf("|") >= 0 && TABLE_SEP.test(lines[i + 1]);
	}
	function isStart(lines, i) {
		var line = lines[i];
		return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(lines, i);
	}
	function cells(row) {
		var s = row.trim();
		if (s.charAt(0) === "|") s = s.slice(1);
		if (s.slice(-1) === "|" && s.slice(-2) !== "\\|") s = s.slice(0, -1);
		return s.split(/(?<!\\)\|/).map(function (cell) { return inline(cell.trim()); });
	}

	function parse(text) {
		var lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
		var blocks = [];
		var i = 0, m;
		while (i < lines.length) {
			var line = lines[i];
			if (isBlank(line)) { i++; continue; }
			if ((m = FENCE.exec(line))) {
				var marker = m[1], body = [];
				i++;
				while (i < lines.length && !(lines[i].trim().indexOf(marker) === 0 && lines[i].trim().replace(/[`~]/g, "") === "")) body.push(lines[i++]);
				i++;
				blocks.push({ t: "code", lang: m[2], text: body.join("\n") });
				continue;
			}
			if ((m = HEADING.exec(line))) { blocks.push({ t: "h", level: m[1].length, c: inline(m[2]) }); i++; continue; }
			if (RULE.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
			if (QUOTE.test(line)) {
				var quoted = [];
				while (i < lines.length && (m = QUOTE.exec(lines[i]))) { quoted.push(m[1]); i++; }
				blocks.push({ t: "quote", c: inline(quoted.join("\n")) });
				continue;
			}
			if (isTableStart(lines, i)) {
				var head = cells(line), rows = [];
				i += 2;
				while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf("|") >= 0) rows.push(cells(lines[i++]));
				blocks.push({ t: "table", head: head, rows: rows });
				continue;
			}
			if ((m = ITEM.exec(line))) {
				var ordered = m[2] !== undefined;
				var list = ordered ? { t: "ol", start: Number(m[2]), items: [] } : { t: "ul", items: [] };
				while (i < lines.length) {
					m = ITEM.exec(lines[i]);
					if (!m || (m[2] !== undefined) !== ordered) break;
					var content = [m[3]];
					i++;
					// Continuation lines: anything up to a blank line, the next item, or another block.
					while (i < lines.length && !isBlank(lines[i]) && !ITEM.test(lines[i]) && !isStart(lines, i)) content.push(lines[i++].trim());
					var joined = content.join("\n"), task = TASK.exec(joined);
					list.items.push(task ? { check: task[1] !== " ", c: inline(task[2]) } : { check: null, c: inline(joined) });
					// A blank line between items of the same kind keeps the list going.
					var next = i;
					while (next < lines.length && isBlank(lines[next])) next++;
					var after = next < lines.length ? ITEM.exec(lines[next]) : null;
					if (next > i && !(after && (after[2] !== undefined) === ordered)) break;
					i = next;
				}
				blocks.push(list);
				continue;
			}
			var para = [line.trim()];
			i++;
			while (i < lines.length && !isBlank(lines[i]) && !isStart(lines, i)) para.push(lines[i++].trim());
			blocks.push({ t: "p", c: inline(para.join("\n")) });
		}
		return blocks;
	}

	function inline(text) {
		var s = String(text == null ? "" : text);
		var out = [];
		var buf = "";
		function flush() { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } }
		function push(node) {
			flush();
			out.push(node);
		}
		var i = 0;
		while (i < s.length) {
			var ch = s.charAt(i);
			if (ch === "\\" && i + 1 < s.length && PUNCT.test(s.charAt(i + 1))) { buf += s.charAt(i + 1); i += 2; continue; }
			if (ch === "`") {
				var run = /^`+/.exec(s.slice(i))[0];
				var close = s.indexOf(run, i + run.length);
				while (close >= 0 && s.charAt(close + run.length) === "`") close = s.indexOf(run, close + run.length + 1);
				if (close < 0) { buf += run; i += run.length; continue; }
				var code = s.slice(i + run.length, close);
				if (code.length > 2 && code.charAt(0) === " " && code.slice(-1) === " " && code.trim()) code = code.slice(1, -1);
				push({ t: "code", v: code });
				i = close + run.length;
				continue;
			}
			if (ch === "*" || ch === "_") {
				var double = s.charAt(i + 1) === ch;
				var width = double ? 2 : 1;
				var delim = double ? ch + ch : ch;
				var end = emphasisClose(s, i, ch, width);
				if (end > 0) {
					push({ t: double ? "b" : "i", c: inline(s.slice(i + width, end)) });
					i = end + width;
					continue;
				}
				buf += delim;
				i += width;
				continue;
			}
			if (ch === "[") {
				var link = /^\[([^\]\n]+)\]\(([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/.exec(s.slice(i));
				if (link && /^https?:\/\//i.test(link[2])) {
					push({ t: "a", href: link[2], c: inline(link[1]) });
					i += link[0].length;
					continue;
				}
			}
			buf += ch;
			i++;
		}
		flush();
		return out;
	}

	// The closing delimiter for an opener at `i`, or -1. An opener is followed by a non-space; an underscore opener and closer
	// must not touch a letter or digit on their outer side (snake_case stays text); the closer follows a non-space.
	function emphasisClose(s, i, ch, width) {
		var first = s.charAt(i + width);
		if (!first || /\s/.test(first) || first === ch) return -1;
		if (ch === "_" && i > 0 && WORD.test(s.charAt(i - 1))) return -1;
		var j = i + width + 1;
		while (j <= s.length - width) {
			var at = s.indexOf(width === 2 ? ch + ch : ch, j);
			if (at < 0) return -1;
			var single = width === 1 && (s.charAt(at + 1) === ch || s.charAt(at - 1) === ch);
			var outerOk = ch !== "_" || !WORD.test(s.charAt(at + width) || " ");
			if (!single && outerOk && !/\s/.test(s.charAt(at - 1))) return at;
			j = at + (single ? 2 : 1);
		}
		return -1;
	}

	root.brigadevMarkdown = { parse: parse, inline: inline };
})(typeof globalThis !== "undefined" ? globalThis : window);
