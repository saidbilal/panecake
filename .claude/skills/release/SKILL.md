---
name: release
description: Cut a Panecake release. Drafts the release notes, shows them in the real What's New popup for approval, then bumps the version, tags, pushes and publishes the GitHub release.
argument-hint: "[x.y.z]"
disable-model-invocation: true
---

# Release Panecake

A release is four things that must agree: the version in `package.json`, a `## x.y.z` section in `CHANGELOG.md`, a `vx.y.z` git tag, and a GitHub release on `saidbilal/panecake`. Running copies of Panecake find the GitHub release through their update check. After a user updates, the app shows that version's `CHANGELOG.md` section in its What's New popup, so the notes are written once and used in both places.

Nothing leaves this machine until the user approves the preview in step 4.

## 1. Check the starting point

- The branch is `main`, the working tree is clean, and after `git fetch` it is not behind `origin/main`. If not, say what is off and stop. Commits that are not pushed yet are fine: they go out with the release in step 5.
- Find the last release with `git describe --tags --abbrev=0`, then read what changed since: `git log <tag>..HEAD` and `git diff --stat <tag>..HEAD`. Read the diffs where a commit message does not say what a user would notice.
- If nothing changed since the last tag, say so and stop.

## 2. Pick the version

Use the argument if one was given. Otherwise propose one: a patch bump when the release only fixes things, a minor bump when it adds something a user can see. Say which and why in one line.

## 3. Write the notes

Add a `## x.y.z` section to `CHANGELOG.md`, above the previous release's section. The popup shows exactly this text.

- Write for someone using the app, not someone reading the code. Say what they can now do and where to find it. Leave out refactors, tests and internal changes.
- One bullet per change, most noticeable first, six at most. Lead with a short bold name: `- **Pin chats.** Right-click a chat and choose Pin to top.`
- Plain and accurate. No slogans, no exclamation marks, no "now you can finally".
- Only bold, lists, inline code and links render well. Images are removed, and headings inside a section look heavy in the popup.
- If updating takes anything beyond the Update button (macOS asking for permissions again because `mac/` changed, for example), end with one bullet that says so.

Then set the version without tagging: `npm version x.y.z --no-git-tag-version`.

## 4. Preview and get approval

Start the preview in the background:

```
npm run preview-notes
```

It starts a second Panecake server on throwaway settings and opens it in the browser with the What's New popup showing, exactly as users will see it after updating. The user's running app is not touched. The preview rereads `CHANGELOG.md` on every page reload.

Also print the notes in the chat inside a code block, then ask the user to choose: publish, edit, or cancel. For edits, change `CHANGELOG.md`, ask them to reload the preview page, and ask again. Do not go on without a clear yes.

When they have answered, stop the preview process you started. Check its PID first: the user's own app runs the same `server.mjs`.

If they cancel, restore `package.json`, `package-lock.json` and `CHANGELOG.md` with `git checkout --` and stop.

## 5. Publish

Only after approval:

1. Commit `CHANGELOG.md`, `package.json` and `package-lock.json` as `Release x.y.z`.
2. Tag it `vx.y.z`.
3. `git push origin main` and `git push origin vx.y.z`.
4. Write the notes to a file in the scratchpad with `node scripts/notes.mjs print x.y.z`, then `gh release create vx.y.z --title "Panecake x.y.z" --notes-file <that file>`.

If a step fails, stop and report where things stand (committed, tagged, pushed or not) instead of retrying blindly.

## 6. Report

Give the release link and one line on what happens next: copies of Panecake with the update check on show an Update button at their next launch or within 12 hours, and the What's New popup appears the first time they open the new version.
