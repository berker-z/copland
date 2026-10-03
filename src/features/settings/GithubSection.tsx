/* ============================================================================
   Settings › instance › github, for admins: the instance's GitHub App
   (worker/githubApp.ts).
   ----------------------------------------------------------------------------
   Without one, a button makes it with GitHub's manifest flow: the browser
   posts the manifest to GitHub in a form (GitHub wants a real form post),
   the admin confirms there, and GitHub comes back to /auth/github/callback,
   which keeps the App and goes on to its install page. With one, it links to
   GitHub to install it on more repos, and can be forgotten.
   ========================================================================== */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppManifestForm, GithubApp } from "@/domain/types";
import { api, send } from "@/lib/api";
import { KEYS } from "@/lib/queries";
import { when } from "@/ui/tone";
import { button, Section } from "./Section";

const GITHUB_KEY = [...KEYS.admin, "github"];

/** Post the manifest to GitHub the way its manifest flow asks: a form, in this tab. */
function postToGithub(form: AppManifestForm) {
  const el = document.createElement("form");
  el.method = "post";
  el.action = form.action;
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "manifest";
  field.value = form.manifest;
  el.appendChild(field);
  document.body.appendChild(el);
  el.submit();
}

export function GithubSection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: GITHUB_KEY, queryFn: () => api<{ app: GithubApp | null }>("/admin/github") });
  const [confirmForget, setConfirmForget] = useState(false);
  const create = useMutation({
    mutationFn: () => send<AppManifestForm>("POST", "/admin/github/manifest"),
    onSuccess: postToGithub,
  });
  const forget = useMutation({
    mutationFn: () => send("DELETE", "/admin/github"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: GITHUB_KEY }),
  });
  const app = data?.app;

  return (
    <Section
      title="github"
      hint="A GitHub App of this instance's own, read-only. Installed on your repos, it tells Copland about branches, PRs and CI, which show on the tasks they name; a board's owner connects repos in the board's settings, if they are an admin."
    >
      {data === undefined ? (
        <p className="text-xs text-muted animate-pulse">loading…</p>
      ) : app ? (
        <div className="text-sm space-y-3">
          <p className="text-ink">
            <a href={app.htmlUrl} target="_blank" rel="noreferrer" className="hover:text-accent">
              {app.slug}
            </a>
            <span className="text-xs text-muted">
              {" "}
              owned by {app.owner}, made {when(app.createdAt)}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <a className={button} href={app.installUrl} target="_blank" rel="noreferrer">
              install on repos
            </a>
            <button
              onClick={() => (confirmForget ? forget.mutate() : setConfirmForget(true))}
              onBlur={() => setConfirmForget(false)}
              className={`px-3 py-1.5 pointer-coarse:py-2.5 border transition-colors ${
                confirmForget ? "border-red text-red" : "border-faint text-muted hover:border-red hover:text-red"
              }`}
            >
              {confirmForget ? "really forget it" : "forget the app"}
            </button>
          </div>
          <p className="text-xs text-muted">
            Forgetting it here leaves it on GitHub: delete it there too, from its settings. Connected repos stay on their boards and hear
            nothing until there is an App again.
          </p>
        </div>
      ) : (
        <div className="text-sm space-y-3">
          <button className={button} onClick={() => create.mutate()} disabled={create.isPending}>
            create GitHub App
          </button>
          <p className="text-xs text-muted">
            GitHub asks you to confirm the App, then to pick the repos it may read. You can change the name it suggests.
          </p>
        </div>
      )}
      {(create.error ?? forget.error) && <p className="text-xs text-red mt-2">{(create.error ?? forget.error)?.message}</p>}
    </Section>
  );
}
