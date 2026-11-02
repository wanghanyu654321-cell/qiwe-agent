export interface ReportCase {
  text: string;
  businessDay: string;
  report: { businessDay: string; storeName: string | null; entries: { customer: string | null; amount: number; employeeName: string; note: string }[] };
}

const line = (customer: string | null, amount: number, employeeName: string, note = '') => ({ customer, amount, employeeName, note });

export const REPORTS: ReportCase[] = [
  { text: '27号\n479(小丽)', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: null, entries: [line(null, 479, '小丽')] } },
  { text: '27号\n479(小丽)\n880(小可)', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: null, entries: [line(null, 479, '小丽'), line(null, 880, '小可')] } },
  { text: '27号\n林倩 10000（小卿）\n金梅 3500（小群）', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: null, entries: [line('林倩', 10000, '小卿'), line('金梅', 3500, '小群')] } },
  { text: '27号明川店\n李欣：888（小美）\n赵莹：1480（小周）\n刘兰：98（小文）\n李秋：98+5800（小周）\n小珊：1580（小胡）\n张涵：1580（小周）', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: '明川店', entries: [line('李欣', 888, '小美'), line('赵莹', 1480, '小周'), line('刘兰', 98, '小文'), line('李秋', 98, '小周'), line('李秋', 5800, '小周'), line('小珊', 1580, '小胡'), line('张涵', 1580, '小周')] } },
  { text: '10.25天澜店\n刘竹：147（小平）\n陈倩：2280（小娟）\n王梅：9707（小龙）\n周娜：1980（小娟娟）\n小芬：588（小秀）', businessDay: '2026-10-27', report: { businessDay: '2026-10-25', storeName: '天澜店', entries: [line('刘竹', 147, '小平'), line('陈倩', 2280, '小娟'), line('王梅', 9707, '小龙'), line('周娜', 1980, '小娟娟'), line('小芬', 588, '小秀')] } },
  { text: '10.25志远店\n岳梅：100（小张）\n刘香：2000（小唐）\n陈轩：1000（小露）\n苏珍：880（小娜）第三个成就', businessDay: '2026-10-27', report: { businessDay: '2026-10-25', storeName: '志远店', entries: [line('岳梅', 100, '小张'), line('刘香', 2000, '小唐'), line('陈轩', 1000, '小露'), line('苏珍', 880, '小娜', '第三个成就')] } },
  { text: '10月24 明川店\n赵芳：35（小美）\n陈老师：98（小美）', businessDay: '2026-10-27', report: { businessDay: '2026-10-24', storeName: '明川店', entries: [line('赵芳', 35, '小美'), line('陈老师', 98, '小美')] } },
  { text: '10月27志远店\n刘一：1990（小勤）\n陈轩：1990（小露）\n欧阳雪：358（小露）', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: '志远店', entries: [line('刘一', 1990, '小勤'), line('陈轩', 1990, '小露'), line('欧阳雪', 358, '小露')] } },
];

const headers = [
  { text: '27号', businessDay: '2026-10-27', day: '2026-10-27', store: null },
  { text: '27号明川店', businessDay: '2026-10-27', day: '2026-10-27', store: '明川店' },
  { text: '10.25天澜店', businessDay: '2026-10-27', day: '2026-10-25', store: '天澜店' },
  { text: '10月24 明川店', businessDay: '2026-10-27', day: '2026-10-24', store: '明川店' },
  { text: '10月27志远店', businessDay: '2026-10-27', day: '2026-10-27', store: '志远店' },
  { text: '10/25天澜店', businessDay: '2026-10-27', day: '2026-10-25', store: '天澜店' },
  { text: '7号', businessDay: '2026-10-27', day: '2026-10-07', store: null },
  { text: '10月7日明川店', businessDay: '2026-10-27', day: '2026-10-07', store: '明川店' },
];
const writings = [
  (note: string) => `李欣：888（小美）${note}`,
  (note: string) => `李欣:888(小美)${note}`,
  (note: string) => `李欣 888（小美）${note}`,
  (note: string) => `李欣：888 (小美) ${note}`.trimEnd(),
];
for (const header of headers) {
  for (const write of writings) {
    REPORTS.push({
      text: `${header.text}\n${write('')}`,
      businessDay: header.businessDay,
      report: { businessDay: header.day, storeName: header.store, entries: [line('李欣', 888, '小美')] },
    });
  }
}
REPORTS.push(
  { text: '27号\n880(小可)', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: null, entries: [line(null, 880, '小可')] } },
  { text: '27号明川店\n李秋：10+20+30（小周）', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: '明川店', entries: [line('李秋', 10, '小周'), line('李秋', 20, '小周'), line('李秋', 30, '小周')] } },
  { text: '27号明川店\n李秋：98＋5800（小周）', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: '明川店', entries: [line('李秋', 98, '小周'), line('李秋', 5800, '小周')] } },
  { text: '27号明川店\n苏珍：880（小娜） 第三个成就', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: '明川店', entries: [line('苏珍', 880, '小娜', '第三个成就')] } },
  { text: '27号明川店\n\n李欣：888（小美）\n', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: '明川店', entries: [line('李欣', 888, '小美')] } },
  { text: '27号 明川店\n李欣：888（小美）', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: '明川店', entries: [line('李欣', 888, '小美')] } },
  { text: '1号\n李欣：888（小美）', businessDay: '2026-10-27', report: { businessDay: '2026-10-01', storeName: null, entries: [line('李欣', 888, '小美')] } },
  { text: '31号\n李欣：888（小美）', businessDay: '2026-10-27', report: { businessDay: '2026-10-31', storeName: null, entries: [line('李欣', 888, '小美')] } },
  { text: '31号\n李欣：888（小美）', businessDay: '2026-11-01', report: { businessDay: '2026-10-31', storeName: null, entries: [line('李欣', 888, '小美')] } },
  { text: '1号\n李欣：888（小美）', businessDay: '2026-11-01', report: { businessDay: '2026-11-01', storeName: null, entries: [line('李欣', 888, '小美')] } },
  { text: '31号明川店\n李欣：888（小美）', businessDay: '2026-04-02', report: { businessDay: '2026-03-31', storeName: '明川店', entries: [line('李欣', 888, '小美')] } },
  { text: '30号\n李欣：888（小美）', businessDay: '2026-02-15', report: { businessDay: '2026-01-30', storeName: null, entries: [line('李欣', 888, '小美')] } },
  { text: '12月31日\n李欣：888（小美）', businessDay: '2026-01-02', report: { businessDay: '2025-12-31', storeName: null, entries: [line('李欣', 888, '小美')] } },
  { text: '1月5日明川店\n李欣：888（小美）', businessDay: '2026-12-20', report: { businessDay: '2027-01-05', storeName: '明川店', entries: [line('李欣', 888, '小美')] } },
  { text: '10月27志远店\r\n刘一：1990（小勤）', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: '志远店', entries: [line('刘一', 1990, '小勤')] } },
  { text: '27号明川店\n李欣：888(小美)帮我写文案', businessDay: '2026-10-27', report: { businessDay: '2026-10-27', storeName: '明川店', entries: [line('李欣', 888, '小美', '帮我写文案')] } },
);

export const CHATS = [
  '你好',
  '在吗',
  '谢谢',
  '今天好累',
  '帮我写一条朋友圈',
  '明天的活动文案怎么写',
  '这个海报帮我改一下',
  '客户想做个套餐',
  '帮我写个小红书标题',
  '投放效果怎么样',
  '质检表今天要交吗',
  '培训课件发我一下',
  '前台晚上谁值班',
  '预约电话是多少',
  '门店地址在哪',
  '我今天走了10000步',
  '哈哈哈哈',
  '收到',
  '好的谢谢店长',
  '明天几点开门',
  '顾客说头发黄了',
  '帮我想一个促销口号',
  '这个月心情不好',
  '晚饭吃什么',
  '小丽今天请假了',
  '把上次的文案发我',
  '朋友圈配图用哪张',
  '你是谁',
  '店里空调太冷了',
  '帮我回复这个差评：一般般',
  '内容再活泼一点',
  '广告预算够不够',
];
