; Svelte Symbol Extraction Queries
; Not used for extraction: SvelteParser (src/parsers/languages/svelte.ts) parses each <script>
; block with the JS/TS parser (M0-12-R8). This query only backs the parse worker's generic
; fallback walk, which runs when the language parser throws.

(script_element) @symbol.kind_class
