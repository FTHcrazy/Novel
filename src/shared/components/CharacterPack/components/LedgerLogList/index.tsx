import { Button } from "antd";
import type { LedgerLog } from "../../pack-ledger";
import { LEDGER_LOG_KEEP } from "../../pack-ledger";
import "./index.scss";

/**
 * 资源流水列表（spec FR-03：最近 N 条，最新在顶；void 记录灰色划线、不计入余额）
 *
 * 章节列展示真实章节（第 N 章 · 标题）：宿主经 `novel-chapters-meta` 批量解析；
 * 映射缺键 = 已删章节；正在解析时当前章先按「本章」占位，无章节上下文显示「—」。
 */
export interface LedgerLogListProps {
  logs: LedgerLog[];
  currentChapterId: string;
  canUndo: boolean;
  onUndo: () => void;
  /** 盘点入口（FR-04）：由宿主以 LedgerAdjustPopover(mode="audit") 注入 */
  auditSlot?: React.ReactNode;
  /** chapterId → 展示名（「第 N 章 · 标题」），由宿主解析注入 */
  chapterNames?: Record<string, string>;
}

function chapterLabel(
  chapterId: string | undefined,
  currentChapterId: string,
  names?: Record<string, string>,
): string {
  if (!chapterId) return "—";
  return names?.[chapterId] ?? (chapterId === currentChapterId ? "本章" : "已删章节");
}

function timeLabel(ts: number): string {
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default function LedgerLogList({ logs, currentChapterId, canUndo, onUndo, auditSlot, chapterNames }: LedgerLogListProps) {
  return (
    <div className="lq-logs">
      <div className="lq-logs__actions">
        <Button size="small" className="lq-logs__audit" onClick={onUndo} disabled={!canUndo}>
          撤销最后一笔
        </Button>
        {auditSlot}
        <span className="lq-logs__hint">最近 {LEDGER_LOG_KEEP} 条 · 更早已清理</span>
      </div>
      {logs.length === 0 ? (
        <p className="lq-logs__empty">还没有流水。用行尾的 − / ＋ 记一笔。</p>
      ) : (
        <ul className="lq-logs__list">
          {logs.map((log) => {
            const chapter = chapterLabel(log.chapterId, currentChapterId, chapterNames);
            return (
              <li
                key={log.id}
                className={`lq-logs__line${log.kind === "void" ? " lq-logs__line--void" : ""}`}
              >
                <span className={`lq-logs__delta lq-logs__delta--${log.delta >= 0 ? "plus" : "minus"}`}>
                  {log.delta >= 0 ? "+" : ""}
                  {log.delta.toLocaleString("en-US")}
                </span>
                <span className="lq-logs__meta">{timeLabel(log.ts)}</span>
                <span className="lq-logs__meta lq-logs__chapter" title={chapter}>
                  {chapter}
                </span>
                <span className="lq-logs__balance">→ {log.balance.toLocaleString("en-US")}</span>
                {log.note ? <span className="lq-logs__note">{log.note}</span> : null}
                {log.kind === "void" ? <span className="lq-logs__voidmark">已撤销</span> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
