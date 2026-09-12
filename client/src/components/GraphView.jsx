import React, { useMemo } from 'react';
import { cx } from '../util.js';
import { Banner, EmptyState } from './Bits.jsx';

const COL_ORDER = ['Mailbox', 'Domain', 'Workspace', 'Email', 'Commitment', 'Calendar', 'Event', 'Storage', 'File', 'DNSRecord', 'SetupAction', 'Check'];
const FRIENDLY_COL_ORDER = ['Email', 'Commitment', 'Event', 'File'];

const TECH = { COL_W: 186, NODE_W: 158, NODE_H: 42, ROW_H: 72, PAD: 16, TOP: 34 };
const FRIENDLY = { COL_W: 264, NODE_W: 248, NODE_H: 80, ROW_H: 180, PAD: 20, TOP: 112 };

const NODE_STYLE = {
  Workspace: { fill: '#122038', stroke: '#3f6fbf', text: '#e4efff' },
  Calendar: { fill: '#1f1a3d', stroke: '#7a5fbf', text: '#ece4ff' },
  Storage: { fill: '#102430', stroke: '#3a7f9d', text: '#d8f0ff' },
  Email: { fill: '#142a49', stroke: '#4b82bd', text: '#e8f1ff' },
  Commitment: { fill: '#302710', stroke: '#a17c31', text: '#ffe5a5' },
  Event: { fill: '#251b42', stroke: '#8763bf', text: '#e9ddff' },
  File: { fill: '#102b2c', stroke: '#357f7d', text: '#d3f4ef' },
  Domain: { fill: '#16305e', stroke: '#4f8cff', text: '#eaf1ff' },
  Mailbox: { fill: '#1b2450', stroke: '#6672d6', text: '#e8ebff' },
  DNSRecord: { fill: '#101d3a', stroke: '#2c4479', text: '#cfe0ff' },
  Check: { fill: '#0f2130', stroke: '#2a5e55', text: '#cdeee2' },
  SetupAction: { fill: '#2a2210', stroke: '#6b5a24', text: '#ffe4ae' }
};

const FRIENDLY_TYPE_LABEL = {
  Email: 'Email',
  Commitment: 'Suggested task',
  Event: 'Meeting',
  File: 'File'
};

const FRIENDLY_EDGE_LABEL = {
  SUGGESTS: 'suggests',
  POSSIBLY_REFERENCES: 'relates to'
};

const FRIENDLY_ICON = {
  Email: '✉',
  Commitment: '◎',
  Event: '◷',
  File: '▣'
};

const STATE_DOT = {
  configured: '#3ecf8e',
  managed: '#66a3ff',
  missing: '#f4b740',
  mismatch: '#f4b740',
  conflict: '#ff6b81',
  failed: '#ff6b81',
  pending: '#b48cff',
  unknown: '#6b7ba3'
};

function labelFor(node) {
  if (['Workspace','Calendar','Event','Storage','File','Email','Commitment'].includes(node.type)) return node.name || node.type;
  if (node.type === 'Domain') return node.name || 'Domain';
  if (node.type === 'DNSRecord') return `${node.dnsType || ''} ${node.name || ''}`.trim() || 'DNS record';
  if (node.type === 'Mailbox') return node.address || 'Mailbox';
  if (node.type === 'Check') return `Check: ${node.scope || ''}`;
  if (node.type === 'SetupAction') return `Action: ${node.kind || ''}`;
  return node.type || 'Node';
}

function friendlyTypeLabel(type) {
  return FRIENDLY_TYPE_LABEL[type] || type;
}

function friendlyEdgeLabel(type) {
  return FRIENDLY_EDGE_LABEL[type] || type.replaceAll('_', ' ').toLowerCase();
}

function titleLines(text, maxLines = 2, lineWidth = 30) {
  const words = String(text || 'Untitled').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ['Untitled'];
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= lineWidth) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word.length > lineWidth ? `${word.slice(0, lineWidth - 1)}…` : word;
    if (lines.length >= maxLines - 1) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (words.join(' ').length > lines.join(' ').length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.endsWith('…') ? last : `${last.replace(/…$/, '')}…`;
  }
  return lines.slice(0, maxLines);
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const SANS = 'Inter, "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export default function GraphView({
  graph,
  degraded,
  status,
  selectedId,
  onSelect,
  friendly = false,
  emptyTitle = 'Nothing in the graph yet',
  emptyChildren = 'Create a plan or a mailbox and the dependency graph will appear here.'
}) {
  const dims = friendly ? FRIENDLY : TECH;
  const { COL_W, NODE_W, NODE_H, ROW_H, PAD, TOP } = dims;

  const { positions, width, height, byId } = useMemo(() => {
    const nodes = (graph && graph.nodes) || [];
    const order = friendly ? FRIENDLY_COL_ORDER : COL_ORDER;
    const groups = new Map(order.map((t) => [t, []]));
    for (const n of nodes) {
      if (!groups.has(n.type)) groups.set(n.type, []);
      groups.get(n.type).push(n);
    }
    const pos = new Map();
    const columnTypes = [
      ...order,
      ...[...groups.keys()].filter((type) => !order.includes(type))
    ].filter((type) => (groups.get(type) || []).length > 0);
    let maxRows = 1;
    let colCount = 0;
    for (const type of columnTypes) {
      const list = groups.get(type) || [];
      const columnIndex = columnTypes.indexOf(type);
      const x = PAD + columnIndex * COL_W;
      if (list.length) colCount = Math.max(colCount, columnIndex + 1);
      list.forEach((n, i) => {
        pos.set(n.id, { x, y: TOP + i * ROW_H, type });
      });
      maxRows = Math.max(maxRows, list.length);
    }
    const w = PAD * 2 + Math.max(1, colCount) * COL_W - (COL_W - NODE_W);
    const h = TOP + Math.max(1, maxRows) * ROW_H + (friendly ? 12 : 0);
    const map = new Map(nodes.map((n) => [n.id, n]));
    return { positions: pos, width: Math.max(w, friendly ? 720 : 640), height: Math.max(h, friendly ? 220 : 200), byId: map };
  }, [graph, friendly, COL_W, NODE_W, ROW_H, PAD, TOP]);

  if (degraded && (!graph || !graph.nodes || graph.nodes.length === 0)) {
    return (
      <Banner tone="warn">
        The graph view is degraded: {status?.lastError || 'Neo4j is unavailable'}.
        Your setup data is still available. Dependency links will return when the graph connection recovers
        {status?.queued ? ` (${status.queued} graph update(s) pending)` : ''}.
      </Banner>
    );
  }
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    return (
      <EmptyState title={emptyTitle} icon="◌">
        {emptyChildren}
      </EmptyState>
    );
  }

  const edges = graph.edges || [];
  const connected = new Set();
  if (selectedId) {
    connected.add(selectedId);
    for (const e of edges) {
      if (e.from === selectedId) connected.add(e.to);
      if (e.to === selectedId) connected.add(e.from);
    }
  }

  function edgePath(from, to) {
    const a = positions.get(from);
    const b = positions.get(to);
    if (!a || !b) return null;
    if (friendly && a.y === b.y) {
      const x1 = a.x + NODE_W / 2;
      const x2 = b.x + NODE_W / 2;
      const span = Math.max(1, Math.abs(b.x - a.x) / COL_W);
      const lift = 20 + span * 26;
      return { d: `M ${x1} ${a.y} C ${x1} ${a.y - lift}, ${x2} ${b.y - lift}, ${x2} ${b.y}`, mx: (x1 + x2) / 2, my: a.y - lift * 0.75 };
    }
    const aRight = b.x >= a.x;
    const x1 = aRight ? a.x + NODE_W : a.x;
    const y1 = a.y + NODE_H / 2;
    const x2 = aRight ? b.x : b.x + NODE_W;
    const y2 = b.y + NODE_H / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
    const c1 = aRight ? x1 + dx : x1 - dx;
    const c2 = aRight ? x2 - dx : x2 + dx;
    return { d: `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  }

  const legendText = friendly
    ? 'Select a card for details.'
    : (edges.length
      ? `Relationships: ${[...new Set(edges.map((edge) => edge.type.replaceAll('_', ' ').toLowerCase()))].join(' · ')}. `
      : '')
      + 'Select a node to highlight its connections.';

  return (
    <div className={cx('graph-wrap', friendly && 'graph-wrap--friendly')}>
      <div className="graph-scroll">
        <svg
          className="graph-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Dependency graph with ${graph.nodes.length} nodes and ${edges.length} relationships. Select a node for details.`}
        >
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="#3a5da8" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const p = edgePath(e.from, e.to);
          if (!p) return null;
          const dim = selectedId && e.from !== selectedId && e.to !== selectedId;
          const edgeLabel = friendly ? friendlyEdgeLabel(e.type) : e.type.replaceAll('_', ' ').toLowerCase();
          return (
            <g key={`${e.from}-${e.to}-${i}`} className={cx(dim && 'dim')}>
              <path
                className={cx('graph-edge', dim && 'dim', friendly && 'graph-edge--suggests')}
                d={p.d}
                markerEnd="url(#arrow)"
              />
              {friendly ? (
                <g className={cx('graph-edge-label-wrap', dim && 'dim')} transform={`translate(${p.mx}, ${p.my})`}>
                  <rect
                    className="graph-edge-label-bg"
                    x={-(edgeLabel.length * 3.4 + 10)}
                    y={-9}
                    width={edgeLabel.length * 6.8 + 20}
                    height={18}
                    rx={6}
                  />
                  <text className="graph-edge-label-friendly" textAnchor="middle" y={4}>
                    {edgeLabel}
                  </text>
                </g>
              ) : null}
              <title>{edgeLabel}</title>
            </g>
          );
        })}
        {[...positions.entries()].map(([id, p]) => {
          const node = byId.get(id);
          const style = NODE_STYLE[node.type] || NODE_STYLE.DNSRecord;
          const dim = selectedId && !connected.has(id);
          const stateDot = !friendly && node.state && STATE_DOT[node.state] ? STATE_DOT[node.state] : null;
          const title = labelFor(node);
          const lines = friendly ? titleLines(title) : [clip(title, stateDot ? 17 : 20)];
          const typeLabel = friendly ? friendlyTypeLabel(node.type) : node.type;
          const icon = friendly ? (FRIENDLY_ICON[node.type] || '•') : null;
          return (
            <g
              key={id}
              className={cx('graph-node', friendly && 'graph-node--friendly', selectedId === id && 'selected')}
              tabIndex={0}
              focusable="true"
              role="button"
              aria-pressed={selectedId === id}
              aria-label={`${labelFor(node)}${node.state ? `, state ${node.state}` : ''}${node.status ? `, status ${node.status}` : ''}. Press Enter for details.`}
              onClick={() => onSelect(node)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(node);
                }
              }}
              style={{ opacity: dim ? (friendly ? 0.78 : 0.35) : 1, cursor: 'pointer' }}
            >
              <title>{title}</title>
              <rect
                x={p.x}
                y={p.y}
                width={NODE_W}
                height={NODE_H}
                rx={friendly ? 12 : 10}
                fill={style.fill}
                stroke={selectedId === id ? '#7fb2ff' : style.stroke}
                strokeWidth={selectedId === id ? 2 : 1.1}
              />
              {friendly ? (
                <>
                  <text x={p.x + 12} y={p.y + 18} fill={style.text} fontSize="11" fontFamily={SANS} opacity={0.82}>
                    {icon} {typeLabel}
                  </text>
                  {lines.map((line, i) => (
                    <text
                      key={i}
                      x={p.x + 12}
                      y={p.y + 38 + i * 16}
                      fill={style.text}
                      fontSize="13.5"
                      fontFamily={SANS}
                      fontWeight={500}
                    >
                      {line}
                    </text>
                  ))}
                </>
              ) : (
                <>
                  {stateDot ? <circle cx={p.x + 14} cy={p.y + NODE_H / 2} r={4.5} fill={stateDot} /> : null}
                  <text x={p.x + (stateDot ? 26 : 12)} y={p.y + NODE_H / 2 + 4} fill={style.text} fontSize="11.5" fontFamily={MONO}>
                    {lines[0]}
                  </text>
                  <text x={p.x + 12} y={p.y + NODE_H - 6} fill="#7d8db5" fontSize="9" fontFamily={MONO}>
                    {typeLabel}{node.state ? ` · ${node.state}` : node.status ? ` · ${node.status}` : ''}
                  </text>
                </>
              )}
            </g>
          );
        })}
        </svg>
      </div>
      <p className="graph-legend muted">{legendText}</p>
    </div>
  );
}

function clip(text, max) {
  const t = String(text || '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
