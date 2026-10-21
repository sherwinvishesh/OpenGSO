---
"opengso-testing": patch
"opengso-generate": patch
"opengso-prod": patch
"opengso-cli": patch
"opengso": patch
---

Two OpenGSO packages installed in one project now share the `opengso` command properly. Every package installs the same bin, and npm links whichever it installed last, so a project with `opengso-cli` as a dev dependency and `opengso-prod` for the server could end up with `npx opengso test` answering "`opengso test` isn't part of opengso-prod" and telling you to install a package you already had. A command the linked package does not ship is now handed to an installed one that does, found in the same `node_modules` tree the running bin came from, with the same arguments, terminal and exit code. The install message only appears when no installed package ships the command.
