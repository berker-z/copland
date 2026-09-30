/* ============================================================================
   The verse pane (/bible_qotd), from nord-dash's BibleWidget: say how you
   feel, get a passage back. The Worker asks OpenAI with the user's own key
   (worker/routes/verse.ts); without one saved, the pane says where to add it
   instead of offering a box that can only fail.
   ========================================================================== */

import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { FEELING_MAX, type Verse } from "@/domain/panes";
import { send } from "@/lib/api";
import { useVault } from "@/lib/queries";
import { WidgetFrame } from "@/ui/WidgetFrame";

export function VersePane({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { data: vault } = useVault();
  const hasKey = vault?.some((e) => e.name === "openai") ?? false;
  const [feeling, setFeeling] = useState("");
  const [quote, setQuote] = useState<Verse | null>(null);

  const ask = useMutation({
    mutationFn: (text: string) => send<Verse>("POST", "/verse", { feeling: text }),
    onSuccess: (verse) => {
      setQuote(verse);
      setFeeling("");
    },
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!feeling.trim() || ask.isPending) return;
    ask.mutate(feeling.trim());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  if (vault && !hasKey) {
    return (
      <WidgetFrame title="/bible_qotd">
        <div className="flex flex-col items-center text-center gap-3 py-4">
          <div className="text-muted text-5xl select-none">†</div>
          <p className="text-muted text-sm max-w-xs">
            This pane asks OpenAI for a passage, with your own key. Add an OpenAI key under api keys in settings.
          </p>
          <button onClick={onOpenSettings} className="text-xs text-muted hover:text-accent uppercase tracking-widest transition-colors">
            [ OPEN_SETTINGS ]
          </button>
        </div>
      </WidgetFrame>
    );
  }

  return (
    <WidgetFrame title="/bible_qotd">
      <div className="flex flex-col">
        {!quote ? (
          <div className="flex flex-col justify-center items-center text-center gap-4 p-4">
            <div className="text-muted text-5xl select-none">†</div>
            <p className="text-ink">How are you feeling today?</p>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="pl-4 border-l-2 border-yellow mb-4 py-1">
              <h3 className="text-yellow mb-2 uppercase tracking-wider">{quote.reference}</h3>
              <p className="text-ink leading-relaxed whitespace-pre-line">"{quote.text}"</p>
            </div>
            <button
              onClick={() => setQuote(null)}
              className="text-xs text-muted hover:text-accent self-center mt-2 uppercase tracking-widest transition-colors"
            >
              [ RESET_QUERY ]
            </button>
          </div>
        )}

        {ask.error && (
          <p className="mt-4 px-3 py-2 text-sm text-red border border-red/60 bg-red/10">! VERSE_FAILED: {ask.error.message}</p>
        )}

        <form onSubmit={submit} className="mt-4 relative">
          <textarea
            value={feeling}
            onChange={(e) => {
              setFeeling(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={onKeyDown}
            placeholder="Query input..."
            maxLength={FEELING_MAX}
            className="w-full bg-raised border border-faint pl-3 pr-12 py-2.5 focus:outline-none focus:border-accent placeholder-muted min-h-[52px] max-h-[150px] resize-none text-ink transition-colors overflow-hidden"
            disabled={ask.isPending}
            rows={1}
          />
          <button
            type="submit"
            disabled={ask.isPending || !feeling.trim()}
            className="absolute right-3 bottom-3 text-muted hover:text-accent disabled:opacity-30 bg-raised pl-2 pt-2"
            aria-label="Ask"
          >
            {ask.isPending ? (
              <div className="w-4 h-4 border-2 border-ink border-t-transparent rounded-full animate-spin" />
            ) : (
              <Send size={17} />
            )}
          </button>
        </form>
      </div>
    </WidgetFrame>
  );
}
