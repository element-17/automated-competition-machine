/** 本地文本复用风险检查；不是原创性、抄袭、AI 或法律判断。无 I/O。 */
export type TextReuseReference = { id: string; title: string; text: string; kind: "source" | "history" };
export type TextReuseOptions = { exemptTexts?: string[] };
export type TextReuseStatus = "clear" | "review" | "blocked" | "unverified" | "not_applicable";
export type TextReuseSkipReason = "translation" | "official_template" | "fixed_form";

export const TEXT_REUSE_THRESHOLDS = Object.freeze({
  minMatchCharacters: 80,
  blockMatchedCharacters: 300,
  blockCoverage: 0.35,
  minBlockComparedCharacters: 300,
  maxExcludedCoverageForClear: 0.5,
  diversityNgramCharacters: 8,
  minimumDistinctNgrams: 24,
  maxOutputCodeUnits: 120_000,
  maxReferenceCodeUnits: 120_000,
  maxTotalReferenceCodeUnits: 600_000,
  maxReferences: 64,
  maxNormalizedCharactersPerText: 200_000,
  maxTotalNormalizedReferenceCharacters: 800_000,
  maxExemptTexts: 64,
  maxTotalExemptCodeUnits: 120_000,
  maxMatches: 2_048,
  maxExclusions: 2_048,
  maxWorkUnits: 20_000_000,
});

/** 所有位置均为原字符串的 UTF-16 偏移，0 起始，end 不包含端点。 */
export type TextReuseMatch = {
  referenceId: string; title: string; kind: "source" | "history";
  quote: string; sourceQuote: string;
  outputStart: number; outputEnd: number; sourceStart: number; sourceEnd: number;
  normalizedCharacters: number;
};
export type TextReuseExclusion = {
  reason: "blockquote" | "quoted_paragraph" | "exempt_text";
  quote: string; outputStart: number; outputEnd: number; normalizedCharacters: number;
};
export type TextReuseReport = {
  status: TextReuseStatus; checked: boolean; complete: boolean; reason: string;
  referenceCount: number; usableReferenceCount: number; checkedReferenceIds: string[];
  normalizedCharacters: number; excludedCharacters: number; comparedCharacters: number;
  matchedCharacters: number; coverage: number;
  matches: TextReuseMatch[]; excluded: TextReuseExclusion[];
  thresholds: typeof TEXT_REUSE_THRESHOLDS; scope: string; limitations: string[];
};

const SCOPE = "仅比较调用方提供的 source/history 正文中较长、实际连续的规范化文本复用；不检索互联网，不判断原创、抄袭、AI 生成、语义相似或法律合规。";
const LIMITATIONS = [
  "clear 仅表示本次参考范围内未见达到阈值的文本复用，不证明原创；缺失参考与未检出均不能作为原创证据。",
  "字符数按 NFKC、转小写并移除标点/空白/符号后的 Unicode 码点计；原文位置保留 UTF-16 偏移。",
  "仅统计至少 80 个连续规范化字符且包含至少 24 个不同 8-gram 的片段；短标题、术语及低信息重复不计入。",
  "引用块、整段引号及调用方明确指定的 exemptTexts 被排除并列出；排除不代表授权、合法性或原创。排除条目可重叠，总量按并集计。",
  "题目、规则及 required 固定表述应由调用方以 exemptTexts 明确提供，不根据词语猜测；翻译、官方模板、固定表单应由调用方跳过并报告 not_applicable。",
  "不检测同义改写、翻译或机制雷同；不得以改词逃避核验。发现风险应核查出处、引用边界及实质贡献。",
  "每个输出片段报告参考中的一个准确出现位置，不枚举同一参考的所有重复位置；多个参考的输出覆盖去重。",
];
const T = TEXT_REUSE_THRESHOLDS;
function report(referenceCount: number): TextReuseReport {
  return { status: "unverified", checked: false, complete: false, reason: "尚未完成比较。",
    referenceCount, usableReferenceCount: 0, checkedReferenceIds: [],
    normalizedCharacters: 0, excludedCharacters: 0, comparedCharacters: 0, matchedCharacters: 0, coverage: 0,
    matches: [], excluded: [], thresholds: T, scope: SCOPE, limitations: [...LIMITATIONS] };
}

/** 适用性由调用方判断；不要把翻译/固定模板送入 assessTextReuse 后再解读成原创结论。 */
export function textReuseNotApplicable(reason: TextReuseSkipReason): TextReuseReport {
  const labels: Record<TextReuseSkipReason, string> = { translation: "翻译任务", official_template: "官方模板", fixed_form: "固定表单" };
  if (!Object.hasOwn(labels, reason)) throw new TypeError("不支持的文本复用跳过原因。");
  return { ...report(0), status: "not_applicable", reason: `调用方判定为${labels[reason]}，未执行文本复用检查；不构成原创结论。` };
}

class Incomplete extends Error {}
function budget() {
  let work = 0;
  return (amount = 1) => {
    work += amount;
    if (work > T.maxWorkUnits) throw new Incomplete("超过确定性计算预算，比较未完成。");
  };
}
type Spend = ReturnType<typeof budget>;
type Normalized = { chars: string[]; starts: number[]; ends: number[] };

// 以字素簇规范化，使组合附加符、兼容字符及代理对仍能映射回完整原文。
function normalize(text: string, spend: Spend): Normalized {
  const result: Normalized = { chars: [], starts: [], ends: [] };
  const segments = new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text);
  for (const { segment, index } of segments) {
    spend();
    for (const char of segment.normalize("NFKC").toLowerCase()) {
      spend();
      if (!/[\p{L}\p{N}\p{M}]/u.test(char)) continue;
      if (result.chars.length >= T.maxNormalizedCharactersPerText)
        throw new Incomplete("规范化字符数超过单篇上限，未截断为通过结果。");
      result.chars.push(char); result.starts.push(index); result.ends.push(index + segment.length);
    }
  }
  return result;
}
function lowerBound(values: number[], value: number, inclusive = false): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < value || (inclusive && values[mid] === value)) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function exclusions(text: string, normalized: Normalized, exemptTexts: string[], spend: Spend) {
  const entries: TextReuseExclusion[] = [];
  const difference = new Int32Array(normalized.chars.length + 1);
  const add = (reason: TextReuseExclusion["reason"], start: number, end: number) => {
    const lo = lowerBound(normalized.ends, start, true), hi = lowerBound(normalized.starts, end);
    if (hi <= lo) return;
    if (entries.length >= T.maxExclusions) throw new Incomplete("排除片段过多，未完成全部范围核验。");
    spend(end - start);
    entries.push({ reason, quote: text.slice(start, end), outputStart: start, outputEnd: end, normalizedCharacters: hi - lo });
    difference[lo]++; difference[hi]--;
  };
  for (const match of text.matchAll(/^[ \t]{0,3}>[^\r\n]*(?:\r?\n|$)/gm))
    add("blockquote", match.index!, match.index! + match[0].length);
  // 单次标签扫描：大量未闭合标签不会引发跨全文回溯；仅排除闭合的块。
  let htmlDepth = 0, htmlStart = 0;
  for (const match of text.matchAll(/<\/?blockquote\b[^<>]*>/gi)) {
    spend();
    if (match[0][1] !== "/") {
      if (!htmlDepth) htmlStart = match.index!;
      htmlDepth++;
    } else if (htmlDepth && --htmlDepth === 0) add("blockquote", htmlStart, match.index! + match[0].length);
  }
  for (const match of text.matchAll(/[^\r\n]+(?:\r?\n(?![ \t]*(?:\r?\n|$))[^\r\n]+)*/g)) {
    const raw = match[0], value = raw.trim().replace(/^(?:引用|引文)[：:]\s*/u, "");
    const pairs = [["“", "”"], ["「", "」"], ["『", "』"], ['"', '"']] as const;
    for (const [open, close] of pairs) {
      if (!value.startsWith(open)) continue;
      const end = value.lastIndexOf(close);
      if (end <= 0) continue;
      const suffix = value.slice(end + close.length).trim();
      if (suffix && !/^(?:[（(](?:来源|出处|引自)[：:][^\r\n]*[）)]|[—–-]{1,2}[^\r\n]+)$/u.test(suffix)) continue;
      add("quoted_paragraph", match.index!, match.index! + raw.length);
      break;
    }
  }
  for (const exempt of exemptTexts) {
    const pattern = normalize(exempt, spend).chars;
    if (!pattern.length) continue;
    // KMP：逐条精确查找豁免文本，不能靠标点/空白变化脱离固定表述的排除范围。
    const prefix = new Int32Array(pattern.length);
    for (let i = 1, j = 0; i < pattern.length; i++) {
      spend();
      while (j && pattern[i] !== pattern[j]) { spend(); j = prefix[j - 1]!; }
      if (pattern[i] === pattern[j]) j++;
      prefix[i] = j;
    }
    for (let i = 0, j = 0; i < normalized.chars.length; i++) {
      spend();
      while (j && normalized.chars[i] !== pattern[j]) { spend(); j = prefix[j - 1]!; }
      if (normalized.chars[i] === pattern[j]) j++;
      if (j === pattern.length) {
        add("exempt_text", normalized.starts[i - j + 1]!, normalized.ends[i]!);
        j = prefix[j - 1]!;
      }
    }
  }
  const mask = new Uint8Array(normalized.chars.length);
  let count = 0, active = 0;
  for (let i = 0; i < mask.length; i++) { active += difference[i]!; if (active) { mask[i] = 1; count++; } }
  entries.sort((a, b) => a.outputStart - b.outputStart || a.outputEnd - b.outputEnd || a.reason.localeCompare(b.reason, "en"));
  return { entries, mask, count };
}

// 两指针计算每个起点达到足够不同 n-gram 的最小终点，避免对每段重新扫描。
function diversityEnds(chars: string[], spend: Spend): Float64Array {
  const width = T.diversityNgramCharacters;
  const grams: string[] = [];
  for (let i = 0; i + width <= chars.length; i++) { spend(width); grams.push(chars.slice(i, i + width).join("")); }
  const result = new Float64Array(chars.length); result.fill(Infinity);
  const counts = new Map<string, number>();
  let right = 0;
  for (let left = 0; left < grams.length; left++) {
    while (right < grams.length && counts.size < T.minimumDistinctNgrams) {
      spend(); const gram = grams[right++]!; counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    if (counts.size >= T.minimumDistinctNgrams) result[left] = right + width - 1;
    const gram = grams[left]!, count = counts.get(gram)!;
    if (count === 1) counts.delete(gram); else counts.set(gram, count - 1);
  }
  return result;
}

type State = { length: number; link: number; end: number; next: Map<string, number> };
// 后缀自动机：参考构建及每篇输出扫描均为线性摊还工作，不做二次方最长公共子串矩阵。
function automaton(chars: string[], spend: Spend): State[] {
  const states: State[] = [{ length: 0, link: -1, end: -1, next: new Map() }];
  let last = 0;
  for (let i = 0; i < chars.length; i++) {
    spend();
    const char = chars[i]!, current = states.length;
    states.push({ length: states[last]!.length + 1, link: 0, end: i, next: new Map() });
    let p = last;
    while (p >= 0 && !states[p]!.next.has(char)) { spend(); states[p]!.next.set(char, current); p = states[p]!.link; }
    if (p >= 0) {
      const q = states[p]!.next.get(char)!;
      if (states[p]!.length + 1 === states[q]!.length) states[current]!.link = q;
      else {
        spend(states[q]!.next.size);
        const clone = states.length;
        states.push({ length: states[p]!.length + 1, link: states[q]!.link, end: states[q]!.end, next: new Map(states[q]!.next) });
        while (p >= 0 && states[p]!.next.get(char) === q) { spend(); states[p]!.next.set(char, clone); p = states[p]!.link; }
        states[q]!.link = clone; states[current]!.link = clone;
      }
    }
    last = current;
  }
  return states;
}
type Span = { start: number; end: number; sourceEnd: number };
function findMatches(output: Normalized, source: Normalized, excluded: Uint8Array, diverse: Float64Array, spend: Spend): Span[] {
  const states = automaton(source.chars, spend), matches: Span[] = [];
  let state = 0, length = 0;
  for (let i = 0; i < output.chars.length; i++) {
    spend();
    if (excluded[i]) { state = 0; length = 0; continue; }
    const char = output.chars[i]!;
    while (state && !states[state]!.next.has(char)) { spend(); state = states[state]!.link; length = states[state]!.length; }
    const next = states[state]!.next.get(char);
    if (next === undefined) { state = 0; length = 0; continue; }
    state = next; length++;
    let start = i + 1 - length;
    const sourceEnd = states[state]!.end + 1;
    // 不把 NFKC 展开字素的一部分伪装成完整原文证据，例如 ﬃ 的尾部 fi。
    if (i + 1 < output.chars.length && output.ends[i] === output.ends[i + 1]) continue;
    if (sourceEnd < source.chars.length && source.ends[sourceEnd - 1] === source.ends[sourceEnd]) continue;
    let sourceStart = sourceEnd - length;
    while (start <= i) {
      spend();
      const outputAdvance = start > 0 && output.starts[start] === output.starts[start - 1]
        ? lowerBound(output.starts, output.starts[start]!, true) - start : 0;
      const sourceAdvance = sourceStart > 0 && source.starts[sourceStart] === source.starts[sourceStart - 1]
        ? lowerBound(source.starts, source.starts[sourceStart]!, true) - sourceStart : 0;
      const advance = Math.max(outputAdvance, sourceAdvance);
      if (!advance) break;
      start += advance; sourceStart += advance;
    }
    if (i + 1 - start < T.minMatchCharacters || diverse[start]! > i + 1) continue;
    const span = { start, end: i + 1, sourceEnd };
    while (matches.length && matches[matches.length - 1]!.start >= start) { spend(); matches.pop(); }
    if (matches.length >= T.maxMatches) throw new Incomplete("实际匹配片段超过报告上限，比较未完成。");
    matches.push(span);
  }
  return matches;
}

/**
 * 仅以未排除正文的去重并集计算覆盖率。显著大篇幅复用才 blocked；单个长片段为 review。
 * 超限返回 unverified/complete:false；非法调用抛 TypeError。不会静默截断并声称 clear。
 * checkedReferenceIds 仅含完成全文比较的参考；incomplete 时计数仅代表已完成部分。
 */
export function assessTextReuse(text: string, references: TextReuseReference[], options: TextReuseOptions = {}): TextReuseReport {
  if (typeof text !== "string" || !Array.isArray(references) || !options || typeof options !== "object")
    throw new TypeError("文本、参考数组或检查选项类型错误。");
  const result = report(references.length), spend = budget();
  const exemptTexts = options.exemptTexts ?? [];
  if (!Array.isArray(exemptTexts)) throw new TypeError("exemptTexts 必须为字符串数组。");
  try {
    if (text.length > T.maxOutputCodeUnits || references.length > T.maxReferences || exemptTexts.length > T.maxExemptTexts)
      throw new Incomplete("输入长度或条目数量超过公开阈值，未执行完整检查。");
    let total = 0, exemptTotal = 0;
    const ids = new Set<string>();
    for (const ref of references) {
      if (!ref || typeof ref.id !== "string" || !ref.id.trim() || typeof ref.title !== "string" || typeof ref.text !== "string" || !["source", "history"].includes(ref.kind))
        throw new TypeError("每条参考必须含准确 id、title、text 及 source/history kind。");
      if (ids.has(ref.id)) throw new TypeError("参考 id 不得重复；不同 id 的重复正文会按覆盖并集去重。");
      ids.add(ref.id); total += ref.text.length;
      if (ref.text.length > T.maxReferenceCodeUnits || total > T.maxTotalReferenceCodeUnits)
        throw new Incomplete("参考正文超过单篇或总量上限，未执行完整检查。");
    }
    for (const exempt of exemptTexts) {
      if (typeof exempt !== "string") throw new TypeError("exemptTexts 只能包含字符串。");
      exemptTotal += exempt.length;
      if (exemptTotal > T.maxTotalExemptCodeUnits) throw new Incomplete("豁免文本总量超过上限，未执行完整检查。");
    }
    const output = normalize(text, spend);
    result.normalizedCharacters = output.chars.length;
    const exclusion = exclusions(text, output, exemptTexts, spend);
    result.excluded = exclusion.entries; result.excludedCharacters = exclusion.count;
    result.comparedCharacters = output.chars.length - exclusion.count;
    if (!result.comparedCharacters) { result.reason = "没有可比较的非排除正文；整篇加引号或全部豁免不能证明原创。"; return result; }
    if (!references.length) { result.reason = "没有参考正文，文本复用风险未核实。"; return result; }
    const diverse = diversityEnds(output.chars, spend), covered = new Uint8Array(output.chars.length);
    let normalizedTotal = 0;
    for (const ref of references) {
      const source = normalize(ref.text, spend);
      normalizedTotal += source.chars.length;
      if (normalizedTotal > T.maxTotalNormalizedReferenceCharacters) throw new Incomplete("规范化参考总量超过上限，比较未完成。");
      if (source.chars.length < T.minMatchCharacters) continue;
      result.usableReferenceCount++;
      const spans = findMatches(output, source, exclusion.mask, diverse, spend);
      if (result.matches.length + spans.length > T.maxMatches) throw new Incomplete("跨参考匹配总量超过报告上限，比较未完成。");
      // 单个参考的区间起点递增，覆盖遍历不会因区间重叠退回，避免二次方计数。
      let visitedEnd = 0;
      for (const span of spans) {
        const outputStart = output.starts[span.start]!, outputEnd = output.ends[span.end - 1]!;
        const sourceStart = source.starts[span.sourceEnd - (span.end - span.start)]!, sourceEnd = source.ends[span.sourceEnd - 1]!;
        spend(outputEnd - outputStart + sourceEnd - sourceStart);
        result.matches.push({ referenceId: ref.id, title: ref.title, kind: ref.kind,
          quote: text.slice(outputStart, outputEnd), sourceQuote: ref.text.slice(sourceStart, sourceEnd),
          outputStart, outputEnd, sourceStart, sourceEnd, normalizedCharacters: span.end - span.start });
        for (let i = Math.max(visitedEnd, span.start); i < span.end; i++) if (!covered[i]) { covered[i] = 1; result.matchedCharacters++; }
        visitedEnd = span.end;
      }
      result.checkedReferenceIds.push(ref.id); result.checked = true;
      result.coverage = result.matchedCharacters / result.comparedCharacters;
    }
    if (!result.usableReferenceCount) { result.reason = "参考为空或均不足 80 个规范化字符，没有足够参考可核实长片段复用。"; return result; }
    result.complete = true;
    if (result.comparedCharacters >= T.minBlockComparedCharacters && result.matchedCharacters >= T.blockMatchedCharacters && result.coverage >= T.blockCoverage) {
      result.status = "blocked"; result.reason = "未标注正文存在显著大量的实际连续复用，达到高复用风险阻塞阈值；请核查来源、引用边界及实质贡献。";
    } else if (result.excludedCharacters / result.normalizedCharacters >= T.maxExcludedCoverageForClear) {
      result.status = "unverified"; result.reason = "至少一半正文被引用标记或固定文本排除，剩余比较不足以给出全文低复用风险结论。";
    } else if (result.matches.length) {
      result.status = "review"; result.reason = "发现较长的实际连续复用片段，但未达到大量复用阻塞阈值，请人工核查。";
    } else {
      result.status = "clear"; result.reason = "在本次有效参考和未排除正文范围内，未见达到阈值的文本复用；不代表原创。";
    }
    return result;
  } catch (error) {
    if (!(error instanceof Incomplete)) throw error;
    result.status = "unverified"; result.complete = false; result.reason = error.message;
    result.coverage = result.comparedCharacters ? result.matchedCharacters / result.comparedCharacters : 0;
    result.limitations.push("incomplete：本次受公开资源上限限制，匹配/覆盖仅为已检查部分，未检查部分不能视为无风险。");
    return result;
  }
}
