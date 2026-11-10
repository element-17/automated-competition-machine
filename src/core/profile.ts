/**
 * 用户资料：配置里已经填写的信息必须被写作、模板填写和验收复用，
 * 不能一边保存了姓名/学校，一边又让作品留【待补充】。
 */
export type UserProfile = {
  school?: string;
  college?: string;
  major?: string;
  identity?: string;
  studentId?: string;
  name?: string;
  phone?: string;
  email?: string;
  advisor?: string;
  teamName?: string;
};

type Field = [keyof UserProfile, string, RegExp];

/** 关键词用于把【待补充：姓名】和「作者姓名」等说法映射到具体资料字段。 */
const fields: Field[] = [
  ["name", "姓名", /姓名|作者|署名/],
  ["studentId", "学号", /学号/],
  ["phone", "电话", /电话|手机|联系方式/],
  ["email", "邮箱", /邮箱|邮件|e-?mail/i],
  ["advisor", "指导教师", /指导教师|指导老师|导师/],
  ["teamName", "团队名称", /团队名称|队伍名称|队名/],
  ["school", "学校", /学校/],
  ["college", "学院", /学院|院系/],
  ["major", "专业", /专业/],
  ["identity", "身份", /身份|学历|年级/],
];

const value = (profile: UserProfile, key: keyof UserProfile) =>
  profile[key]?.trim() || "";

/** 已填写的资料条目，按固定顺序输出。 */
export function profileEntries(profile: UserProfile | undefined) {
  return fields
    .map(([key, label]) => ({ label, value: value(profile || {}, key) }))
    .filter((x) => x.value);
}

/** 已知资料直接复用；可选字段留空，官方必填缺项明确登记。 */
export function profileNote(profile: UserProfile | undefined): string {
  const entries = profileEntries(profile);
  const missing = "未提供的个人信息不得编造；可选字段留空，官方明确必填的缺项集中写进 needs_input，不能宣称已填写完整。实测数据、照片和调研结果必须另有真实材料支撑。";
  if (!entries.length) return `用户资料：未提供。${missing}`;
  return `用户资料（已由用户提供，直接复用且不重复索要）：${entries.map((x) => `${x.label}：${x.value}`).join("；")}。${missing}`;
}

/**
 * 把写作模型留下的【待补充：个人信息】直接替换成用户资料。
 * 只处理能唯一对应到已填写字段的标记；其他标记（实测数据、照片等）保留。
 */
export function applyProfile(
  text: string,
  profile: UserProfile | undefined,
): string {
  return text.replace(/【待补充[:：]\s*([^】]+)】/g, (whole, raw: string) => {
    if (/实测|数据|照片|调研|访谈|实验|证明|证书|签章|盖章|亲笔|签名|授权|同意书|价格/.test(raw))
      return whole;
    const matched = fields
      .map(([key, , re]) => ({ key, index: raw.search(re) }))
      .filter((x) => x.index >= 0)
      .sort((a, b) => a.index - b.index)
      .map((x) => value(profile || {}, x.key));
    return matched.length && matched.every(Boolean) ? matched.join("、") : whole;
  });
}

/**
 * 需求条目是否已经被用户资料覆盖：条目里提到的个人信息字段都有值时，
 * 这条待补资料就不必再向用户索要。
 */
export function coveredByProfile(
  request: string,
  profile: UserProfile | undefined,
): boolean {
  if (/实测|数据|照片|调研|访谈|实验|证明|证书|签章|盖章|亲笔|签名|授权|同意书|价格/.test(request))
    return false;
  const matched = fields.filter(([, , re]) => re.test(request));
  if (!matched.length) return false;
  return matched.every(([key]) => !!value(profile || {}, key));
}
