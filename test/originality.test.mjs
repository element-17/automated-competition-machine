import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// 内存转译且不触碰共享 dist，支持与主代理并行开发及 node --test 单文件执行。
const source = await readFile(new URL("../src/workflows/originality.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const { assessTextReuse, textReuseNotApplicable, TEXT_REUSE_THRESHOLDS: T } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`);

// 不依赖随机数或时钟；不同字符区间可控制有/无共同片段及精确长度。
const passage = (length, base = 0x4e00) => Array.from({ length }, (_, i) => String.fromCodePoint(base + i)).join("");
const ref = (text, id = "source-1", kind = "source") => ({ id, title: `参考 ${id}`, text, kind });
const normalized = (value) => [...value.normalize("NFKC").toLowerCase()].filter((char) => /[\p{L}\p{N}\p{M}]/u.test(char)).join("");
function evidence(report, text, references) {
  for (const match of report.matches) {
    const source = references.find((item) => item.id === match.referenceId);
    assert.ok(source, "准确 id 必须来自输入参考");
    assert.equal(match.quote, text.slice(match.outputStart, match.outputEnd));
    assert.equal(match.sourceQuote, source.text.slice(match.sourceStart, match.sourceEnd));
    assert.equal(normalized(match.quote), normalized(match.sourceQuote));
    assert.equal([...normalized(match.quote)].length, match.normalizedCharacters);
  }
  assert.ok(report.coverage >= 0 && report.coverage <= 1);
  assert.notEqual(report.status, "original");
}

test("长篇源文本复用触发保守阻塞并提供原文位置和阈值", () => {
  const copied = passage(420), text = `分析：${copied}\n补充：${passage(300, 0x7000)}`;
  const refs = [ref(`前言${copied}后记`)];
  const report = assessTextReuse(text, refs);
  assert.equal(report.status, "blocked");
  assert.equal(report.complete, true);
  assert.equal(report.checked, true);
  assert.equal(report.matchedCharacters, 420);
  assert.equal(report.coverage, 420 / 724);
  assert.equal(report.thresholds.blockCoverage, 0.35);
  assert.equal(report.matches[0].outputStart, 3);
  assert.deepEqual(report.checkedReferenceIds, ["source-1"]);
  assert.match(report.scope, /不是|不判断/);
  evidence(report, text, refs);
});

test("本地历史产物正文复用同样识别并保留 kind 和准确 id", () => {
  const text = passage(500), refs = [ref(text, "history:job-001:report", "history")];
  const report = assessTextReuse(text, refs);
  assert.equal(report.status, "blocked");
  assert.equal(report.matches[0].kind, "history");
  assert.equal(report.matches[0].referenceId, "history:job-001:report");
  evidence(report, text, refs);
});

test("独立正文、短术语及低信息口号重复不阻塞，不称原创", () => {
  const term = "机器学习技术创新";
  const refs = [ref(`${term}${passage(600)}`)];
  const report = assessTextReuse(`${term}${passage(600, 0x7000)}`, refs);
  assert.equal(report.status, "clear");
  assert.equal(report.matchedCharacters, 0);
  assert.match(report.reason, /未见达到阈值.*不代表原创/);
  const repetitive = assessTextReuse(term.repeat(100), [ref(term.repeat(80))]);
  assert.equal(repetitive.status, "clear");
  assert.equal(repetitive.matches.length, 0);
});

test("标点、空白、大小写、NFKC、组合字符及代理对仍映射原文", () => {
  const stem = `ＡＢＣ１２３Cafe\u0301\u{20000}ﬃ${passage(350)}`;
  const changed = [...stem.normalize("NFKC").toLowerCase()].join(" ，\n");
  const refs = [ref(`源：${stem}。`)];
  const text = `🙂\n${changed}！`;
  const report = assessTextReuse(text, refs);
  assert.equal(report.status, "blocked");
  assert.equal(report.matches[0].outputStart, 3);
  assert.equal(report.matches[0].sourceStart, 2);
  evidence(report, text, refs);
});

test("单个长片段只 review；连续片段及覆盖率阻塞阈值均按边界判断", () => {
  assert.equal(assessTextReuse(passage(79), [ref(passage(400))]).status, "clear");
  assert.equal(assessTextReuse(passage(80), [ref(passage(400))]).status, "review");
  assert.equal(assessTextReuse(passage(299), [ref(passage(400))]).status, "review");
  assert.equal(assessTextReuse(passage(300), [ref(passage(400))]).status, "blocked");
  const copied = passage(350), refs = [ref(copied)];
  const atThreshold = assessTextReuse(copied + passage(650, 0x7000), refs);
  assert.equal(atThreshold.coverage, 0.35);
  assert.equal(atThreshold.status, "blocked");
  assert.equal(assessTextReuse(copied + passage(651, 0x7000), refs).status, "review");
});

test("明确 blockquote、整段引文及 HTML 引用排除且可解释", () => {
  const quote = passage(380), independent = passage(850, 0x7000), refs = [ref(quote)];
  for (const marked of [`> ${quote}`, `“${quote}”（来源：已提供参考）`, `<blockquote>${quote}</blockquote>`]) {
    const text = `${marked}\n\n${independent}`;
    const report = assessTextReuse(text, refs);
    assert.equal(report.status, "clear");
    assert.equal(report.matchedCharacters, 0);
    assert.equal(report.comparedCharacters, 850);
    assert.ok(report.excludedCharacters >= 380);
    assert.ok(report.excluded.length > 0);
    for (const excluded of report.excluded) assert.equal(excluded.quote, text.slice(excluded.outputStart, excluded.outputEnd));
  }
});

test("整篇套引号、整篇引用和整篇豁免均无法取得 clear", () => {
  const text = passage(600), refs = [ref(text)];
  for (const marked of [`“${text}”`, `> ${text}`, `「${text}」`]) {
    const report = assessTextReuse(marked, refs);
    assert.equal(report.status, "unverified");
    assert.equal(report.checked, false);
    assert.equal(report.comparedCharacters, 0);
  }
  assert.equal(assessTextReuse(text, refs, { exemptTexts: [text] }).status, "unverified");
  const almostAllQuoted = assessTextReuse(`“${text}”\n\n${passage(100, 0x7000)}`, refs);
  assert.equal(almostAllQuoted.status, "unverified");
  assert.equal(almostAllQuoted.complete, true);
  assert.match(almostAllQuoted.reason, /至少一半/);
});

test("固定题目、规则及 required 表述由调用方精确豁免，规范化后仍排除", () => {
  const required = `required：${passage(400)}`;
  const refs = [ref(required)], text = `${required.replaceAll("", " ")}\n\n${passage(900, 0x7000)}`;
  const report = assessTextReuse(text, refs, { exemptTexts: [required] });
  assert.equal(report.status, "clear");
  assert.equal(report.comparedCharacters, 900);
  assert.equal(report.excludedCharacters, 408);
  assert.equal(report.excluded[0].reason, "exempt_text");
  assert.equal(assessTextReuse(required, refs).status, "blocked", "不凭 required 关键词猜测豁免");
});

test("重叠来源、重复正文和重复豁免按输出字符并集计数", () => {
  const text = passage(700), refs = [ref(text.slice(0, 400), "a"), ref(text.slice(250, 650), "b"), ref(text.slice(0, 400), "c")];
  const report = assessTextReuse(text, refs);
  assert.equal(report.matchedCharacters, 650);
  assert.equal(report.coverage, 650 / 700);
  assert.deepEqual(report.matches.map((match) => match.referenceId), ["a", "b", "c"]);
  evidence(report, text, refs);
  const exempt = assessTextReuse(text, refs, { exemptTexts: [text.slice(0, 200), text.slice(100, 300)] });
  assert.equal(exempt.excludedCharacters, 300);
  assert.equal(exempt.comparedCharacters, 400);
  assert.equal(exempt.matchedCharacters, 350);
});

test("多个实际长片段可累计覆盖，排除片段不会把两边拼接成命中", () => {
  const first = passage(160), second = passage(170, 0x6000);
  const text = `${first}不同连接词${second}${passage(300, 0x7000)}`;
  const refs = [ref(first + passage(100, 0x8000) + second)];
  const report = assessTextReuse(text, refs);
  assert.equal(report.status, "blocked");
  assert.equal(report.matchedCharacters, 330);
  assert.equal(report.matches.length, 2);
  evidence(report, text, refs);
  const split = passage(80);
  const divided = assessTextReuse(split.slice(0, 40) + "固定要求" + split.slice(40), [ref(split)], { exemptTexts: ["固定要求"] });
  assert.equal(divided.matches.length, 0);
});

test("没有参考、空正文参考和过短参考不能误报 clear", () => {
  for (const refs of [[], [ref("")], [ref(" ，。 \n")], [ref(passage(79))]]) {
    const report = assessTextReuse(passage(500), refs);
    assert.equal(report.status, "unverified");
    assert.equal(report.checked, false);
    assert.equal(report.complete, false);
    assert.equal(report.usableReferenceCount, 0);
  }
  const mixed = assessTextReuse(passage(500), [ref("", "empty"), ref(passage(1000, 0x7000), "useful")]);
  assert.equal(mixed.referenceCount, 2);
  assert.equal(mixed.usableReferenceCount, 1);
  assert.deepEqual(mixed.checkedReferenceIds, ["useful"]);
  assert.equal(assessTextReuse("", [ref(passage(500))]).status, "unverified");
});

test("翻译、官方模板和固定表单由调用方 skip 并明确 not_applicable", () => {
  for (const reason of ["translation", "official_template", "fixed_form"]) {
    const report = textReuseNotApplicable(reason);
    assert.equal(report.status, "not_applicable");
    assert.equal(report.checked, false);
    assert.equal(report.complete, false);
    assert.match(report.reason, /调用方判定.*未执行.*不构成原创/);
  }
  assert.throws(() => textReuseNotApplicable("anything"), TypeError);
});

test("超大输入、参考数及豁免数显式 incomplete，不静默截断", () => {
  const cases = [
    ["甲".repeat(T.maxOutputCodeUnits + 1), [ref(passage(500))]],
    [passage(500), [ref("甲".repeat(T.maxReferenceCodeUnits + 1))]],
    [passage(500), Array.from({ length: T.maxReferences + 1 }, (_, i) => ref(passage(80), `r${i}`))],
    [passage(500), Array.from({ length: 6 }, (_, i) => ref("甲".repeat(T.maxReferenceCodeUnits), `r${i}`))],
    [passage(500), [ref(passage(500))], { exemptTexts: Array(T.maxExemptTexts + 1).fill("要求") }],
    ["㍿".repeat(55_000), [ref(passage(500))]],
  ];
  for (const args of cases) {
    const report = assessTextReuse(...args);
    assert.equal(report.status, "unverified");
    assert.equal(report.complete, false);
    assert.match(report.reason, /超过/);
    assert.match(report.limitations.join(" "), /incomplete/);
  }
});

test("规范化展开字素边界不会产生并不相等的原文引语", () => {
  const body = passage(200);
  for (const [text, source] of [[`fi${body}`, `ﬃ${body}`], [`ﬃ${body}`, `fi${body}`], [`${body}fi`, `${body}ﬃ`]]) {
    const refs = [ref(source)];
    const report = assessTextReuse(text, refs);
    assert.equal(report.status, "review");
    assert.equal(report.matchedCharacters, 200);
    evidence(report, text, refs);
  }
});

test("大量未闭合 HTML 标签不能造成回溯爆炸或自动豁免", { timeout: 10_000 }, () => {
  const copied = passage(400);
  const text = "<blockquote>".repeat(7_000) + copied;
  const report = assessTextReuse(text, [ref(copied)]);
  assert.equal(report.complete, true);
  assert.equal(report.status, "review");
  assert.equal(report.excludedCharacters, 0);
  assert.equal(report.matchedCharacters, 400);
});

test("计算预算耗尽时明确保留未完成状态及已检查范围", { timeout: 15_000 }, () => {
  const text = passage(20_000).repeat(5);
  const refs = Array.from({ length: 64 }, (_, index) => ref(text.slice(0, 9_000), `budget-${index}`));
  const report = assessTextReuse(text, refs, { exemptTexts: Array(64).fill("不存在的固定表述") });
  assert.equal(report.status, "unverified");
  assert.equal(report.complete, false);
  assert.match(report.reason, /计算预算/);
  assert.ok(report.checkedReferenceIds.length < refs.length);
  assert.match(report.limitations.join(" "), /incomplete/);
});

test("非法调用明确抛错，不伪造低风险报告", () => {
  assert.throws(() => assessTextReuse(passage(500), [ref(passage(500)), ref(passage(500))]), /id 不得重复/);
  assert.throws(() => assessTextReuse(passage(500), [{ id: "", title: "", text: "", kind: "source" }]), TypeError);
  assert.throws(() => assessTextReuse(passage(500), [], { exemptTexts: [123] }), TypeError);
});

test("上限内大篇正文及高重复输入在有界预算内运行，结果确定", { timeout: 15_000 }, () => {
  const text = passage(20_000).repeat(4), refs = [ref(text)];
  const report = assessTextReuse(text, refs);
  assert.equal(report.status, "blocked");
  assert.equal(report.matchedCharacters, 80_000);
  assert.equal(report.matches.length, 1);
  evidence(report, text, refs);
  const repeated = "固定短语".repeat(20_000);
  assert.equal(assessTextReuse(repeated, [ref(repeated)]).status, "clear");
  const small = passage(800);
  assert.deepEqual(assessTextReuse(small, [ref(small)]), assessTextReuse(small, [ref(small)]));
});
