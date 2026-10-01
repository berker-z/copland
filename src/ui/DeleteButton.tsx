import { useState } from "react";
import { Trash2 } from "lucide-react";

/**
 * The trash icon in a modal's header, beside the close button. The first
 * click arms it ("delete?" in red), the second deletes; moving focus away
 * disarms it.
 */
export function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      onClick={() => (armed ? onDelete() : setArmed(true))}
      onBlur={() => setArmed(false)}
      className={`tap p-2 flex items-center gap-1.5 hover:bg-raised transition-colors ${armed ? "text-red" : "hover:text-red"}`}
      title={armed ? "Click again to delete" : "Delete"}
    >
      <Trash2 size={18} />
      {armed && <span className="text-xs">delete?</span>}
    </button>
  );
}
