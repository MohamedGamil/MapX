<template>
  <ul><li v-for="t in tags" :key="t.id">{{ t.name }}</li></ul>
</template>

<script>
import axios from 'axios';

const BASE = 'blog-categories';

export default {
  data: () => ({ tags: [] }),
  methods: {
    load() { return axios.get('/api/tags'); } /* L10 */,
    category(id) { return axios.get(`/api/${BASE}/${id}`); } /* L11 */,
    ghost() { return axios.get('/ghost'); } /* L12 */,
  },
};
</script>
