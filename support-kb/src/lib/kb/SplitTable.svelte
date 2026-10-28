<script lang="ts">
  import { getDeskProblems } from '#lib/kb/split-4471';

  let { ticket = 4471 }: { ticket?: number } = $props();

  const data = $derived(getDeskProblems(ticket));
</script>

<p class="sum">
  <strong>{data.total}</strong> unique reports in #{ticket} · split into <strong>{data.problems.length}</strong> distinct problems
</p>

<table>
  <thead>
    <tr>
      <th>cause</th>
      <th>reports</th>
      <th>tenants</th>
      <th>seen</th>
      <th>ticket</th>
    </tr>
  </thead>
  <tbody>
    {#each data.problems as p (p.cause)}
      <tr>
        <td><code>{p.cause}</code></td>
        <td><strong>{p.reports}</strong></td>
        <td>{p.tenants}</td>
        <td>{p.firstSeen} → {p.lastSeen}</td>
        <td><code>{p.ticketRef}</code></td>
      </tr>
    {/each}
  </tbody>
</table>

{#each data.problems as p (p.cause)}
  {#if p.oneDayMove}
    <p class="note">{p.oneDayMove} reports read as a one-day move; filed under <code>{p.cause}</code> by tenant.</p>
  {/if}
{/each}

<style>
  .sum { font-size: 1.1rem; }
  .note { color: var(--muted); font-size: 0.85em; }
</style>
