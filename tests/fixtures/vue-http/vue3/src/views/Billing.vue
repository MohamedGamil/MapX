<script setup lang="ts">
import { apiService } from '../apiService';

const invoices = await apiService.get('billing/v1/invoices'); /* L28 */
const invoice = (id: number) => apiService.get(`billing/v1/invoices/${id}`); /* L29 */
const health = await fetch('/api/health'); /* L30 */
const notices = await fetch('/api/notices/latest', { method: 'GET' }); /* L31 */
const found = await fetch('/api/posts/search', { method: 'POST', body: '{}' }); /* L32 */
</script>

<template>
  <section>{{ invoices }} {{ health }} {{ notices }} {{ found }}</section>
</template>
