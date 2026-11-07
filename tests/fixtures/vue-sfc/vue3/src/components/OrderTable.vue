<template>
  <DataList :items="orders" v-slot="{ item, select }">
    <button type="button" @click="select(item)">{{ item.number }}</button>
  </DataList>
  <DataList :items="orders">
    <template #row="{ refund }">
      <a href="#" @click="refund">Refund</a>
    </template>
    <template #footer>
      <button type="button" @click="exportCsv">Export</button>
    </template>
  </DataList>
</template>

<script setup>
import DataList from './DataList.vue';

const orders = [];

function select() {}
function refund() {}
function exportCsv() {}
</script>
