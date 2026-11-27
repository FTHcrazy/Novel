/**
 * 就地改名弹框（大纲 / 时间线 / 时代段共用）：命令式入口见 ./openRename。
 * 禁用原生 prompt（AGENTS §6.1.2）。
 */
import { useEffect, useRef, useState } from "react";
import { Input, Modal } from "antd";
import { useOutlineStore } from "../../store/useOutlineStore";
import { bindRenameDialog } from "./openRename";
import "./index.scss";

function RenameDialog() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const targetRef = useRef<string | null>(null);
  const renameProjectOf = useOutlineStore((s) => s.renameProjectOf);

  useEffect(() => {
    bindRenameDialog((name, projectId) => {
      targetRef.current = projectId;
      setValue(name);
      setOpen(true);
    });
    return () => bindRenameDialog(null);
  }, []);

  const confirm = async (): Promise<void> => {
    const projectId = targetRef.current;
    const name = value.trim();
    setOpen(false);
    targetRef.current = null;
    if (!projectId || !name) return;
    await renameProjectOf(projectId, name);
  };

  return (
    <Modal
      title="重命名"
      open={open}
      okText="确定"
      cancelText="取消"
      onCancel={() => {
        setOpen(false);
        targetRef.current = null;
      }}
      onOk={() => void confirm()}
    >
      <Input
        value={value}
        maxLength={30}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onPressEnter={() => void confirm()}
      />
    </Modal>
  );
}

export default RenameDialog;
