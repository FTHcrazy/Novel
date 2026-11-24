import { Segmented } from "antd";
import "./index.scss";

/**
 * 行囊形态切换（spec FR-06）：`台账` ↔ `进阶`。
 *
 * 台账 = 默认形态（打开即记账）；进阶 = 现有 10 模块仪表盘（功能零改动）。
 * 形态偏好进 `novel_pack_ui`（即改即存，不进草稿）。
 */
export interface PackModeSwitchProps {
  /** 当前形态（受控） */
  mode: "quickcard" | "advanced";
  onChange: (mode: "quickcard" | "advanced") => void;
}

export default function PackModeSwitch({ mode, onChange }: PackModeSwitchProps) {
  return (
    <Segmented
      className="lq-mode"
      value={mode}
      onChange={(value) => onChange(value as "quickcard" | "advanced")}
      options={[
        { label: "台账", value: "quickcard" },
        { label: "进阶", value: "advanced" },
      ]}
    />
  );
}
