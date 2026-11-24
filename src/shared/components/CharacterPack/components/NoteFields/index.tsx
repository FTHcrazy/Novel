import { Button, Input, Popconfirm } from "antd";
import { LEDGER_FIELD_HINTS } from "../../pack-ledger";
import "./index.scss";

/**
 * 备注与规则备忘（spec FR-05）：无预设的自由「字段名 + 内容」行。
 *
 * 空态引导列举调研高频用法（敌人战力表 / 系统规则备忘 / 兑换价格表）——
 * 引导文案点的是「系统流作者要维护一份规则承诺清单」（spec 附录 A），
 * 但**不做预设数据**：身份 / 外貌 / 性格类预设已在 v1.2 全部移除。
 */
export interface NoteFieldItem {
  id: string;
  name: string;
  value: string;
  sortOrder: number;
}

export interface NoteFieldsProps {
  fields: NoteFieldItem[];
  canAdd: boolean;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onValue: (id: string, value: string) => void;
  onDelete: (id: string) => void;
}

export default function NoteFields({ fields, canAdd, onAdd, onRename, onValue, onDelete }: NoteFieldsProps) {
  return (
    <section className="lq-notes" aria-label="备注与规则备忘">
      {fields.length === 0 ? (
        <p className="lq-notes__empty">
          记点自由文字：{LEDGER_FIELD_HINTS.join(" / ")}……
        </p>
      ) : (
        fields.map((field) => (
          <div key={field.id} className="lq-notes__field">
            <div className="lq-notes__head">
              <Input
                className="lq-notes__name"
                value={field.name}
                maxLength={20}
                variant="borderless"
                placeholder="备忘标题"
                onChange={(event) => onRename(field.id, event.target.value)}
              />
              <Popconfirm
                title={`删除「${field.name}」？`}
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => onDelete(field.id)}
              >
                <Button type="text" className="lq-notes__del" aria-label={`删除 ${field.name}`}>
                  ✕
                </Button>
              </Popconfirm>
            </div>
            <Input.TextArea
              className="lq-notes__value"
              value={field.value}
              variant="borderless"
              /* 不用 autoSize：它的「挂载测量 → 二次回写」两帧循环就是卡片
                 伸缩闪烁的来源（rows 1/2 都躲不开）。Chromium 123+ 的
                 field-sizing: content 由浏览器原生自适应高度，零测量零回写，
                 配合 scss 里的 max-height 承担原 maxRows 8 的截断。 */
              placeholder="写点备忘……"
              onChange={(event) => onValue(field.id, event.target.value)}
            />
          </div>
        ))
      )}
      <Button type="dashed" block className="lq-notes__add" onClick={onAdd} disabled={!canAdd}>
        ＋ 添加备忘
      </Button>
    </section>
  );
}
