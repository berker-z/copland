/* ============================================================================
   "Move to…": what a long press on a card opens on a touchscreen, where HTML5
   drag does not fire. Picking a stage sends the same patch as the task
   modal's stage buttons, which lands the task at the bottom of that stage.
   ========================================================================== */

import type { BoardDetail } from "@/domain/types";
import { useUpdateTask } from "@/lib/tasks";
import { ModalFrame } from "@/ui/ModalFrame";
import { toneText } from "@/ui/tone";

interface MoveSheetProps {
  detail: BoardDetail;
  taskId: string;
  onOpen: () => void;
  onClose: () => void;
}

export function MoveSheet({ detail, taskId, onOpen, onClose }: MoveSheetProps) {
  const update = useUpdateTask(detail.board.id);
  const task = detail.tasks.find((t) => t.id === taskId);
  if (!task) return null;

  return (
    <ModalFrame title={`${task.key} · move to`} subtitle={task.title} onClose={onClose} size="sm" fit bodyClassName="!p-0">
      {detail.stages.map((stage) => {
        const here = stage.id === task.stageId;
        return (
          <button
            key={stage.id}
            disabled={here}
            onClick={() => {
              update.mutate({ id: task.id, patch: { stageId: stage.id } });
              onClose();
            }}
            className="w-full flex items-center gap-3 px-5 py-3.5 text-left border-b border-divider hover:bg-raised disabled:cursor-default transition-colors"
          >
            <span className={toneText(stage.tone)}>{stage.name}</span>
            {here && <span className="ml-auto text-xs text-muted">here</span>}
          </button>
        );
      })}
      <button onClick={onOpen} className="w-full px-5 py-3.5 text-left text-muted hover:text-accent hover:bg-raised transition-colors">
        open task
      </button>
    </ModalFrame>
  );
}
