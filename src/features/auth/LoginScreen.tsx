import { Lock } from "lucide-react";
import { loginUrl } from "@/lib/api";

/* What /auth/callback puts in ?login= when it refuses someone (worker/auth.ts). */
const REASONS: Record<string, string> = {
  failed: "Sign-in failed. Try again.",
  not_invited: "This instance is invite-only. Ask its admin for an invite link.",
  invite_used: "That invite link has already been used.",
  invite_email: "That invite is for a different email address.",
  disabled: "This account has been disabled.",
  mismatch: "This email belongs to a different Google account here.",
};

export function LoginScreen() {
  const reason = new URLSearchParams(location.search).get("login");
  const message = reason ? (REASONS[reason] ?? REASONS.failed) : null;

  return (
    <div className="fixed inset-0 z-50 bg-divider flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-surface border border-faint">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-divider text-blue text-xs tracking-[0.16em] uppercase">
          <Lock size={13} />
          system_access
          <span className="flex-1 border-t border-faint/50" aria-hidden />
        </div>

        <div className="p-8 flex flex-col items-center text-center">
          <h2 className="text-bright mb-2">copland</h2>
          <p className="text-ink mb-8 text-sm leading-relaxed opacity-80 max-w-xs">
            Sign in to reach your dashboard and boards.
          </p>

          {message && (
            <div className="mb-6 p-3 w-full border border-red/60 bg-red/10 text-red text-xs uppercase">
              ! {message} !
            </div>
          )}

          <a
            href={loginUrl()}
            className="w-full py-3 px-4 bg-raised border border-faint hover:border-accent hover:text-accent text-ink transition-colors flex items-center justify-center gap-3"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12.545,10.239v3.821h5.445c-0.712,2.315-2.647,3.972-5.445,3.972c-3.332,0-6.033-2.701-6.033-6.032s2.701-6.032,6.033-6.032c1.498,0,2.866,0.549,3.921,1.453l2.814-2.814C17.503,2.988,15.139,2,12.545,2C7.021,2,2.543,6.477,2.543,12s4.478,10,10.002,10c8.396,0,10.249-7.85,9.426-11.748L12.545,10.239z" />
            </svg>
            <span>SIGN IN WITH GOOGLE</span>
          </a>
        </div>
      </div>
    </div>
  );
}
