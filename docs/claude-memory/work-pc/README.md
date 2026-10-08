# Memory notes from the work PC

A copy of the Claude memory notes kept on the work PC, taken on 2026-10-08, so that they
travel with the repository. The notes one level up (`docs/claude-memory/*.md`) are the home
PC's own; these sit in their own folder so that neither set overwrites the other.

## What is here

Eight notes: how the owner likes to be answered, the names he uses for his projects, and the
routines for the JARVIS app (pushing, release notes, publishing a GitHub release with the
installer, restarting after a build). `MEMORY.md` is their index.

## What is not here, on purpose

Seven notes about the company's own systems stay on the work PC and are not copied to
GitHub. Some hold sign-in details and a signing key; others describe weaknesses that are not
fixed yet. A private repository is still a copy on someone else's servers, kept in its history
for good, so those do not belong in one.

## Using them on another PC

Pulling the repository brings these files, but Claude does not read memory from here. It
reads it from that PC's own memory folder:

    C:\Users\<you>\.claude\projects\<the project's folder name>\memory\

To put them to use there, ask JARVIS on that PC to "load the memory notes from
docs/claude-memory/work-pc". That means: copy each note into the folder above, and add its
line from this `MEMORY.md` to the `MEMORY.md` already there. Where a note here disagrees
with one already on that PC, ask which one stands rather than keeping both - the two PCs
were told different things at different times (for one: whether JARVIS installs its own
updates, or leaves that to the Update button).

This is a snapshot. It goes out of date until it is copied again.
