<script lang="ts">
  import { getSplitProblems } from '#lib/kb/split-4471';

  let { ticket = 4471 }: { ticket?: number } = $props();

  const problems = $derived(getSplitProblems(ticket));
  const total = $derived(problems.reduce((sum, p) => sum + p.count, 0));
</script>

<p class="sum">
  <strong>{total}</strong> unique reports in #{ticket} · split into <strong>{problems.length}</strong> distinct problems
</p>

<table>
  <thead>
    <tr>
      <th>problem</th>
      <th>reports</th>
      <th>channels</th>
      <th>tenants</th>
      <th>seen</th>
    </tr>
  </thead>
  <tbody>
    {#each problems as p (p.key)}
      <tr>
        <td>
          <code>{p.key}</code>
          <div class="desc">{p.title}</div>
        </td>
        <td><strong>{p.count}</strong></td>
        <td>{p.channels.join(', ')}</td>
        <td>{p.tenants.length}</td>
        <td>{p.firstSeen} → {p.lastSeen}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .sum { font-size: 1.1rem; }
  .desc { font-size: 0.85em; color: var(--muted); margin-top: 0.2rem; }
</style>

