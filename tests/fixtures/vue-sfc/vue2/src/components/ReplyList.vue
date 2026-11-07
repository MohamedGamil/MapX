<docs>
Lists a ticket's replies. Usage:

<template>
  <ReplyList :replies="replies" @select="archive()" />
</template>
</docs>

<template>
  <div class="reply-list">
    <button type="button" @click="reload">Reload</button>
    <ReplyTable :rows="replies">
      <template slot-scope="{ remove }">
        <button type="button" @click="remove">Delete</button>
      </template>
    </ReplyTable>
    <p v-for="format in formatters" :key="format.name">{{ format(replies) }}</p>
    <pre v-pre>{{ archive() }} <ReplyPreview /></pre>
  </div>
</template>

<script>
import ReplyTable from './ReplyTable.vue';
import ReplyPreview from './ReplyPreview.vue';

export default {
  name: 'ReplyList',
  components: { ReplyTable, ReplyPreview },
  props: { replies: Array, formatters: Array },
  methods: {
    reload() {
      setTimeout(function () {
        this.fetchReplies();
      }, 0);
    },
    remove() {},
    format() {},
    archive() {},
  },
};
</script>
