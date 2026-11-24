import { useEffect, useState } from "react";
import { Button, Input, InputNumber, Popover } from "antd";
import type { LedgerResource } from "../../pack-ledger";
import { LEDGER_NOTE_MAX } from "../../pack-ledger";
import { QTY_MAX } from "../../pack-config";
import "./index.scss";

/**
 * 记账 / 盘点 Popover（spec 11.5：唯一的记账入口）
 *
 * - `mode="adjust"`：± 触发，只决定默认方向，数量可改任意整数；
 * - `mode="audit"`：盘点核对（FR-04），输入实际值 → 差值预览 → 确认生成修正流水。
 *
 * 预览先行是硬要求：作者确认前必须知道「这一笔会把余额变成多少」。
 */
export interface LedgerAdjustPopoverProps {
  resource: LedgerResource;
  mode: "adjust" | "audit";
  /** adjust：默认方向（± 按钮语义）；audit 忽略 */
  direction: 1 | -1;
  /** 差值预览的口径文案，如「账面 3,500」 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (value: number, note: string) => void;
  children: React.ReactNode;
}

export default function LedgerAdjustPopover({
  resource,
  mode,
  direction,
  open,
  onOpenChange,
  onConfirm,
  children,
}: LedgerAdjustPopoverProps) {
  const [value, setValue] = useState<number | null>(direction);
  const [note, setNote] = useState("");

  // 每次打开重置为该触发方式的默认值（±1 / 当前余额）
  useEffect(() => {
    if (open) {
      setValue(mode === "adjust" ? direction : resource.count);
      setNote("");
    }
  }, [open, mode, direction, resource.count]);

  const confirm = () => {
    if (value === null || !Number.isFinite(value)) return;
    onConfirm(value, note.trim());
    onOpenChange(false);
  };

  const preview =
    mode === "adjust"
      ? `余额 ${resource.count.toLocaleString("en-US")} → ${(resource.count + (value ?? 0)).toLocaleString("en-US")}`
      : value !== null && value !== resource.count
        ? `账面 ${resource.count.toLocaleString("en-US")} → 差值 ${(value - resource.count > 0 ? "+" : "")}${(value - resource.count).toLocaleString("en-US")}，将记一笔「盘点修正」`
        : "与当前余额一致，确认后仅记录盘点时间";

  const title = mode === "adjust" ? `记账 · ${resource.name}` : `盘点核对 · ${resource.name}`;

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      arrow={false}
      open={open}
      onOpenChange={onOpenChange}
      classNames={{ root: "lq-pop" }}
      content={
        <div className="lq-adjust">
          <p className="lq-adjust__title">{title}</p>
          <div className="lq-adjust__row">
            <span className="lq-adjust__label">{mode === "adjust" ? "数量" : "实际应有"}</span>
            <InputNumber
              className="lq-adjust__input"
              value={value}
              onChange={(next) => setValue(next)}
              precision={0}
              min={-QTY_MAX}
              max={QTY_MAX}
              onPressEnter={confirm}
              autoFocus
            />
          </div>
          <div className="lq-adjust__row">
            <span className="lq-adjust__label">备注</span>
            <Input
              className="lq-adjust__input"
              value={note}
              maxLength={LEDGER_NOTE_MAX}
              onChange={(event) => setNote(event.target.value)}
              placeholder="可选，如「购丹方」"
              onPressEnter={confirm}
            />
          </div>
          <p className={`lq-adjust__preview${mode === "audit" && value === resource.count ? " lq-adjust__preview--ok" : ""}`}>
            {preview}
          </p>
          <div className="lq-adjust__actions">
            <Button size="small" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="small" type="primary" onClick={confirm} disabled={value === null}>
              {mode === "adjust" ? "确认记账" : "确认盘点"}
            </Button>
          </div>
        </div>
      }
    >
      {children}
    </Popover>
  );
}
