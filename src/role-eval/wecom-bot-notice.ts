import type {ReportDelivery} from './manager-store.js';
/** Shared wording for persisted delivery facts; an ACK never proves phone receipt. */
export function botDeliveryNotice(delivery:ReportDelivery):string{
 return {prepared:'通知待投递',blocked:'明确尚未发送，可在恢复后重试',attempting:'通知正在尝试或中途退出，请勿重复投递',accepted:'平台已受理，不代表手机实收',rejected:'平台已拒绝，请核实原因；不会自动重发',unknown:'通知结果未知，请勿重复投递；可继续查询入账结果'}[delivery.state];
}
