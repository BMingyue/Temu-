export type SectionId = 'patrol' | 'maintenance' | 'launch';
export const sections = [
  {id: 'patrol', title: '巡店', detail: '查预警 · 看数据 · 做巡检', first: 'patrol'},
  {id: 'maintenance', title: '维护', detail: '管商品 · 报活动 · 处理异常', first: 'product-status'},
  {id: 'launch', title: '上新', detail: '选品采图 · 生图 · 店小秘上架', first: 'home'},
] as const;
export const tools = [
  {id:'patrol', title:'巡店预警', section:'patrol'},
  {id:'daily', title:'日常巡检', section:'patrol'},
  {id:'analysis', title:'数据分析', section:'patrol'},
  {id:'product-status', title:'商品状态', section:'maintenance'},
  {id:'activity', title:'活动作业', section:'maintenance'},
  {id:'traffic-accelerator', title:'流量加速器', section:'maintenance'},
  {id:'qualification', title:'商品资质与合规', section:'maintenance'},
  {id:'features', title:'运营辅助', section:'maintenance'},
  {id:'delisting', title:'商品批量下架', section:'maintenance'},
  {id:'collector', title:'采集任务中心', section:'maintenance'},
  {id:'filetools', title:'长文件名迁移', section:'maintenance'},
  {id:'more', title:'辅助与设置', section:'maintenance'},
  {id:'home', title:'上新总览', section:'launch'},
  {id:'selection', title:'选品与采图', section:'launch'},
  {id:'images', title:'GPT 批量生图', section:'launch'},
  {id:'listing', title:'店小秘上架', section:'launch'},
  {id:'traffic', title:'历史页面快照', section:'maintenance', extra:true},
  {id:'overview', title:'CSV 经营复盘', section:'maintenance', extra:true},
  {id:'catalog', title:'历史商品目录', section:'maintenance', extra:true},
  {id:'data', title:'数据中心', section:'maintenance', extra:true},
  {id:'reviews', title:'行动记录', section:'maintenance', extra:true},
  {id:'settings', title:'观察线设置', section:'maintenance', extra:true},
] as const;
export function sectionForTab(tab: string): SectionId {
  return tools.find(tool => tool.id === tab)?.section || 'maintenance';
}
