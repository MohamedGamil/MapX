# Vendored schemas (test only)

These files validate the CI reporters of `mapx check` (M5-07, `tests/arch-reporters.test.ts`). They are test inputs; nothing in `src/` loads them, and the npm package does not ship them. Both are copied unmodified.

## `sarif-schema-2.1.0.json`

- **What:** the official JSON schema of the Static Analysis Results Interchange Format (SARIF) Version 2.1.0, Errata 01, OASIS Standard.
- **Source:** <https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json>, downloaded 2026-11-03.
- **sha256:** `c3b4bb2d6093897483348925aaa73af03b3e3f4bd4ca38cef26dcb4212a2682e`
- **Draft:** JSON Schema draft-04. The test gives ajv (draft-07) a copy with `$schema` dropped and `id` renamed `$id`; the schema uses no other draft-04 construct (no boolean `exclusiveMinimum`/`exclusiveMaximum`).
- **Licence:** the OASIS copyright notice below, which permits copying and redistribution of the unmodified deliverable with the notice.

> Copyright © OASIS Open 2023. All Rights Reserved.
>
> All capitalized terms in the following text have the meanings assigned to them in the OASIS Intellectual Property Rights Policy (the "OASIS IPR Policy"). The full Policy may be found at the OASIS website: [https://www.oasis-open.org/policies-guidelines/ipr/].
>
> This document and translations of it may be copied and furnished to others, and derivative works that comment on or otherwise explain it or assist in its implementation may be prepared, copied, published, and distributed, in whole or in part, without restriction of any kind, provided that the above copyright notice and this section are included on all such copies and derivative works. However, this document itself may not be modified in any way, including by removing the copyright notice or references to OASIS, except as needed for the purpose of developing any document or deliverable produced by an OASIS Technical Committee (in which case the rules applicable to copyrights, as set forth in the OASIS IPR Policy, must be followed) or as required to translate it into languages other than English.
>
> The limited permissions granted above are perpetual and will not be revoked by OASIS or its successors or assigns.
>
> This document and the information contained herein is provided on an "AS IS" basis and OASIS DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTY THAT THE USE OF THE INFORMATION HEREIN WILL NOT INFRINGE ANY OWNERSHIP RIGHTS OR ANY IMPLIED WARRANTIES OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. OASIS AND ITS MEMBERS WILL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF ANY USE OF THIS DOCUMENT OR ANY PART THEREOF.

(Quoted from the Notices section of *SARIF Version 2.1.0 Plus Errata 01*, <https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/sarif-v2.1.0-errata01-os-complete.html>.)

## `junit-10.xsd`

- **What:** the JUnit XML schema the Jenkins xUnit plugin validates JUnit reports with (Surefire/Ant flavour).
- **Source:** <https://raw.githubusercontent.com/jenkinsci/xunit-plugin/master/src/main/resources/org/jenkinsci/plugins/xunit/types/model/xsd/junit-10.xsd>, downloaded 2026-11-03.
- **sha256:** `a1a816f58d1bf95ebabf371994df0b9246dee66ea9572fbec4f9296f1b2c0ff6`
- **Licence:** MIT, Copyright (c) 2014 Gregory Boissinot; the full notice is the file's header comment.
