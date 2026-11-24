import { Modal, Popover } from "antd";
import { LEDGER_TEMPLATES } from "../../pack-ledger";
import "./index.scss";

/**
 * 资源模板 Popover（spec FR-02）：6 套题材模板，选择即**追加**（余额 0），
 * 已有资源时由宿主先过一次确认（「追加不覆盖，同名跳过」）。
 *
 * ◈ 标注进度型资源：只由模板带入，手动添加默认余额型（RK-07 认知成本控制）。
 */
export interface LedgerTemplatePopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已有资源数（>0 时选择先确认） */
  existingCount: number;
  onPick: (templateKey: string) => void;
  children: React.ReactNode;
}

export default function LedgerTemplatePopover({
  open,
  onOpenChange,
  existingCount,
  onPick,
  children,
}: LedgerTemplatePopoverProps) {
  const pick = (key: string) => {
    const run = () => {
      onPick(key);
      onOpenChange(false);
    };
    if (existingCount > 0) {
      Modal.confirm({
        title: "追加模板资源",
        content: "将按模板追加资源（余额 0），已有资源保持不变；同名资源跳过。",
        okText: "追加",
        cancelText: "取消",
        onOk: run,
      });
      return;
    }
    run();
  };

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      arrow={false}
      open={open}
      onOpenChange={onOpenChange}
      classNames={{ root: "lq-tpl-pop" }}
      content={
        <div className="lq-tpl" role="menu">
          {LEDGER_TEMPLATES.map((template) => (
            <button
              key={template.key}
              type="button"
              className="lq-tpl__item"
              onClick={() => pick(template.key)}
            >
              <span className="lq-tpl__name">{template.label}</span>
              <span className="lq-tpl__desc">{template.desc}</span>
            </button>
          ))}
        </div>
      }
    >
      {children}
    </Popover>
  );
}
