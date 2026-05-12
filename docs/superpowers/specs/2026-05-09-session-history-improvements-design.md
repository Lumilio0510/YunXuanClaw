# Session History Improvements Design

**Date:** 2026-05-09
**Status:** Draft

## Problem

The sidebar session list has three issues:
1. **No search** — users scroll through all sessions to find one
2. **No rename** — sessions keep auto-generated names, making them hard to identify
3. **Session isolation bug** — switching sessions may leak messages from the previous session

## Scope

Three focused changes to the existing sidebar and chat store. No new pages, no backend schema changes.

---

## 1. Sidebar Search Bar

**What:** A text input at the top of the sidebar session list that filters sessions by title as you type.

**Behavior:**
- Input appears above the session list, below the "New Chat" button
- Typing filters the session list in real-time (client-side, no API call)
- Filter matches case-insensitively against session title
- Clear button (X) resets the filter
- When filter is active, show a count like "3 of 12 sessions"
- Empty state: "No sessions match your search"
- Filter state is ephemeral — cleared when sidebar closes or on navigation

**Implementation:**
- Add `sessionFilter: string` to chat store
- Add `filteredSessions` computed getter that filters `sessions` by title
- Sidebar renders `filteredSessions` instead of `sessions` when filter is non-empty
- No backend changes — all filtering is in-memory on the renderer

---

## 2. Inline Session Rename

**What:** Double-click a session name in the sidebar to edit it inline.

**Behavior:**
- Double-click on session title text enters edit mode
- Session name becomes an input field pre-filled with current name
- Enter or blur saves the new name
- Escape cancels and reverts
- Empty input reverts to previous name (no blank names)
- Single-click still selects the session as before
- Visual feedback: input field has a subtle border when in edit mode

**Implementation:**
- Add `renameSession(sessionId: string, newName: string)` action to chat store
- Action calls the existing `sessions.rename` API route
- On success, update the session in local store
- Sidebar item component tracks local `isEditing` state
- Debounce save on blur to avoid double-save with Enter

---

## 3. Session Isolation Fix

**What:** Ensure switching sessions fully replaces the message list without leaking messages from the previous session.

**Behavior:**
- When switching sessions, clear the current message list immediately
- Show a loading state while the new session's messages load
- Never display messages from session A while viewing session B

**Implementation:**
- In `switchSession` action: set `messages = []` before loading new session data
- Add `isLoadingSession: boolean` to store for loading state
- Set `isLoadingSession = true` on switch, `false` after messages load
- Chat page shows a spinner/skeleton when `isLoadingSession` is true
- Verify the race condition: if user clicks session B then quickly session C, only C's messages load

---

## Out of Scope

- Full-text message content search (follow-up)
- Session pinning/favorites (follow-up)
- Session export (follow-up)
- Session grouping/folders
- Date-based filtering
- Backend schema changes

## Files Changed

| File | Change |
|------|--------|
| `src/stores/chat.ts` | Add `sessionFilter`, `isLoadingSession` state; add `filteredSessions` getter |
| `src/stores/chat/session-actions.ts` | Update `switchSession` to clear messages and set loading state |
| `src/stores/chat/history-actions.ts` | Add `renameSession` action |
| `src/components/layout/Sidebar.tsx` | Add search bar, inline rename, filtered list rendering |
| `src/pages/Chat/index.tsx` | Add loading state for session switch |
| `src/i18n/locales/en/chat.json` | Add search/rename i18n strings |
| `src/i18n/locales/zh/chat.json` | Add search/rename i18n strings |

## Testing

- Unit: `filteredSessions` getter with various filter strings
- Unit: `renameSession` action calls API and updates store
- Unit: `switchSession` clears messages and sets loading
- E2E: Type in search bar, verify session list filters
- E2E: Double-click rename, verify save and cancel
- E2E: Switch sessions rapidly, verify no message leak
