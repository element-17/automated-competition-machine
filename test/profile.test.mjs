import test from "node:test";
import assert from "node:assert/strict";
import { applyProfile, coveredByProfile, profileNote } from "../dist/core/profile.js";

test("资料占位必须所有字段齐全才替换，不抹掉复合缺项", () => {
  assert.equal(applyProfile("【待补充：姓名、学校】", { name: "测试作者" }), "【待补充：姓名、学校】");
  assert.equal(applyProfile("【待补充：姓名、学校】", { name: "测试作者", school: "测试学校" }), "测试作者、测试学校");
  assert.equal(applyProfile("【待补充：签名】", { name: "测试作者" }), "【待补充：签名】");
  assert.equal(applyProfile("【待补充：姓名及实测数据】", { name: "测试作者" }), "【待补充：姓名及实测数据】");
});

test("已知姓名不能覆盖同条请求中的实测材料或真实签署", () => {
  const profile = { name: "测试作者", school: "测试学校" };
  assert.equal(coveredByProfile("作者姓名、学校", profile), true);
  for (const request of ["作者姓名和实测数据", "学校证明", "作者亲笔签名", "作者授权同意书"])
    assert.equal(coveredByProfile(request, profile), false, request);
  assert.match(profileNote(undefined), /官方明确必填/);
  assert.match(profileNote(profile), /直接复用/);
});
