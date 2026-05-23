; Vue Reference Extraction Queries

; Import statements (from <script> block)
(import_statement
  source: (string (string_fragment) @ref.target_import)) @ref.type_import

; Function/method calls
(call_expression
  function: (identifier) @ref.target_call) @ref.type_call

; Method calls on receiver: obj.method()
(call_expression
  function: (member_expression
    property: (property_identifier) @ref.target_call)) @ref.type_call

; Component references in defineComponent imports
(call_expression
  function: (identifier) @_fn
  (#match? @_fn "^(defineComponent|defineProps|defineEmits|defineExpose|defineSlots|defineModel|defineOptions|withDefaults|ref|reactive|computed|watch|watchEffect|onMounted|onUnmounted|inject|provide|useRouter|useRoute|useStore|useFetch)$")
  ) @ref.type_call
