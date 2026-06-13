# Glue notes drop zone

Each build phase writes **exactly one** file here named `PHASE-<X>-GLUE.md` (its own, unique name — so
parallel sessions never collide). It lists every change a SHARED file needs, as copy-pasteable
snippets. Phase Z reads all of them and applies the shared-file edits. No phase except Z edits shared
files directly.
