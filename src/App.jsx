import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bitable, dashboard, DashboardState, SourceType } from '@lark-base-open/js-sdk';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  Handle,
  Position,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const TABLE_ID = 'tblSEvcWK6sfbtdU'; // 总表（从在线表格同步）
const DRAFT_TABLE_ID = 'tblUAqCjDSj0Dmrm'; // 流程图草稿表
const PLATE_ORDER = ['FCT板级', '组件', '整机自检', '整机产测', '模型打印'];

// 状态色：前三种固定，之后新增状态从 EXTRA 色池按首次出现顺序自动分配
const STATUS_COLOR = {
  已有做法: '#2E7D32',
  待确认: '#E08A00',
  缺口: '#D9433F',
};
const EXTRA_STATUS_COLORS = [
  '#1D6FB8', '#6D4FC2', '#0E7C86', '#C23A6B', '#5E7C1F',
  '#A05A0C', '#3A47B8', '#9D174D', '#0F766E', '#7C2D12',
];
const STATUS_FALLBACK = '#B8B6AD'; // 无状态兜底灰

const PLATE_COLOR = {
  FCT板级: { fill: '#B5D4F4', stroke: '#185FA5', text: '#0C447C' },
  组件: { fill: '#C0DD97', stroke: '#3B6D11', text: '#27500A' },
  整机自检: { fill: '#FAC775', stroke: '#854F0B', text: '#633806' },
  整机产测: { fill: '#CECBF6', stroke: '#534AB7', text: '#3C3489' },
  模型打印: { fill: '#F7C1C1', stroke: '#A32D2D', text: '#791F1F' },
  '(未分板块)': { fill: '#D3D1C7', stroke: '#5F5E5A', text: '#444441' },
};

const DIAMOND_W = 160; // 菱形宽
const DIAMOND_H = 80; // 菱形高
const NODE_GAP = 48; // 节点横向间距
const STEP_X = DIAMOND_W + NODE_GAP; // 208
const STEP_Y = 150; // 行间距
const LABEL_W = 92; // 左侧分组标签宽

// 兼容文本字段值
function getText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((seg) => (seg && seg.text) || '').join('');
  if (typeof v === 'object') return v.text || v.name || v.value || '';
  return String(v);
}

// 兼容单选字段值
function getSelect(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const first = v[0];
    if (first == null) return '';
    if (typeof first === 'string') return first;
    return first.text || first.name || '';
  }
  if (typeof v === 'object') return v.text || v.name || '';
  return '';
}

async function readAllRecords(table) {
  try {
    const all = [];
    let pageToken;
    do {
      const res = await table.getRecords({ pageSize: 200, pageToken });
      if (res && res.records) all.push(...res.records);
      pageToken = res && res.pageToken;
      if (!res || !res.hasMore) break;
    } while (pageToken);
    if (all.length) return all;
  } catch (e) {
    /* fallback */
  }
  const ids = await table.getRecordIdList();
  const rows = [];
  for (const id of ids) rows.push(await table.getRecordById(id));
  return rows;
}

function severity(s) {
  if (s === '缺口') return 3;
  if (s === '待确认') return 2;
  if (s === '已有做法') return 1;
  return 0;
}

// 相同编号合并成一个节点（取第一个名称、最严重状态）
function mergeByCode(items) {
  const map = new Map();
  for (const it of items) {
    const key = (it.plate || '(未分板块)') + '|' + (it.code || it.name);
    if (!map.has(key)) {
      map.set(key, { ...it });
    } else {
      const cur = map.get(key);
      if (severity(it.status) > severity(cur.status)) cur.status = it.status;
    }
  }
  return Array.from(map.values());
}

// 从表数据中提取「状态 → 颜色」映射（固定前三，其余按首次出现顺序自动分配）
function buildStatusMap(items) {
  const map = {};
  const order = [];
  const present = new Set((items || []).map((it) => it.status).filter(Boolean));
  for (const s of Object.keys(STATUS_COLOR)) {
    if (present.has(s)) {
      map[s] = STATUS_COLOR[s];
      order.push(s);
    }
  }
  let i = 0;
  for (const it of items || []) {
    const s = it.status;
    if (s && !(s in map)) {
      map[s] = EXTRA_STATUS_COLORS[i % EXTRA_STATUS_COLORS.length];
      order.push(s);
      i++;
    }
  }
  return { map, order };
}

// 由表数据生成初始横向泳道图
function buildInitial(items, statusMap) {
  const merged = mergeByCode(items);
  const g = {};
  for (const p of PLATE_ORDER) g[p] = [];
  for (const it of merged) {
    const plate = it.plate || '(未分板块)';
    if (!g[plate]) g[plate] = [];
    g[plate].push(it);
  }
  for (const k of Object.keys(g)) {
    g[k].sort((a, b) => (a.code || a.name).localeCompare(b.code || b.name, undefined, { numeric: true }));
  }
  const nodes = [];
  const edges = [];
  PLATE_ORDER.forEach((plate, pi) => {
    const list = g[plate] || [];
    if (!list.length) return;
    const y = pi * STEP_Y;
    const labelId = `label-${plate}`;
    nodes.push({
      id: labelId,
      type: 'label',
      position: { x: 0, y },
      data: { label: plate, plate },
    });
    let cx = LABEL_W + NODE_GAP;
    const startId = `start-${plate}`;
    nodes.push({ id: startId, type: 'start', position: { x: cx, y: y + 16 }, data: {} });
    edges.push({ id: `e-${labelId}-${startId}`, source: labelId, target: startId, type: 'straight' });
    cx += 80 + NODE_GAP;

    let prevId = startId;
    list.forEach((it) => {
      const id = `${plate}|${it.code || it.name}`;
      const fill = (statusMap && statusMap[it.status]) || STATUS_FALLBACK;
      nodes.push({
        id,
        type: 'diamond',
        position: { x: cx, y },
        data: {
          code: it.code,
          name: it.name,
          status: it.status,
          plate,
          recordId: it.recordId,
          fill,
          text: '#ffffff',
        },
      });
      edges.push({ id: `e-${prevId}-${id}`, source: prevId, target: id, type: 'straight' });
      prevId = id;
      cx += DIAMOND_W + NODE_GAP;
    });

    const endId = `end-${plate}`;
    nodes.push({ id: endId, type: 'end', position: { x: cx, y: y + 16 }, data: {} });
    edges.push({ id: `e-${prevId}-${endId}`, source: prevId, target: endId, type: 'straight' });
  });
  return { nodes, edges };
}

// 加载草稿后，按当前尺寸重算坐标（修复旧草稿因尺寸调整导致的重叠）
function relayoutDraft(nodes) {
  const result = nodes.map((n) => ({ ...n, position: { ...n.position } }));
  const labels = result.filter((n) => n.type === 'label').sort((a, b) => a.position.y - b.position.y);
  labels.forEach((label, li) => {
    const oldY = label.position.y;
    const newY = li * STEP_Y;
    const plate = label.data && label.data.plate;
    const ds = result.filter((n) => n.type === 'diamond' && Math.abs(n.position.y - oldY) < 6);
    ds.sort((a, b) => a.position.x - b.position.x);
    const startX = LABEL_W + NODE_GAP + 80 + NODE_GAP;
    ds.forEach((n, i) => {
      n.position.x = startX + i * (DIAMOND_W + NODE_GAP);
      n.position.y = newY;
    });
    label.position.x = 0;
    label.position.y = newY;
    const st = result.find((n) => n.id === `start-${plate}`);
    const en = result.find((n) => n.id === `end-${plate}`);
    if (st) { st.position.x = LABEL_W + NODE_GAP; st.position.y = newY + 16; }
    if (en) { en.position.x = startX + ds.length * (DIAMOND_W + NODE_GAP); en.position.y = newY + 16; }
  });
  return result;
}

// 加载草稿后，按最新状态表为工序节点补色（兼容旧草稿、支持新增状态）
function normalizeDraftColors(nodes, statusMap) {
  return (nodes || []).map((n) => {
    if (n.type === 'diamond' || n.type === 'rect') {
      const fill = (n.data && n.data.status && statusMap[n.data.status]) || STATUS_FALLBACK;
      return { ...n, data: { ...n.data, fill, text: '#ffffff' } };
    }
    return n;
  });
}

// 从飞书「流程图草稿」表读取编辑结果
async function loadDraftFromTable() {
  const table = await bitable.base.getTableById(DRAFT_TABLE_ID);
  const ids = await table.getRecordIdList();
  if (!ids || !ids.length) return null;
  const field = await table.getFieldByName('草稿数据');
  const rec = await table.getRecordById(ids[0]);
  const raw = rec && rec.fields ? rec.fields[field.id] : null;
  const json = getText(raw);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

// 将编辑结果写入飞书「流程图草稿」表
async function saveDraftToTable(nodes, edges) {
  const table = await bitable.base.getTableById(DRAFT_TABLE_ID);
  const field = await table.getFieldByName('草稿数据');
  const json = JSON.stringify({ nodes, edges });
  const seg = [{ type: 'text', text: json }];
  const ids = await table.getRecordIdList();
  if (ids && ids.length) {
    await table.setRecord(ids[0], { fields: { [field.id]: seg } });
  } else {
    await table.addRecord({ fields: { [field.id]: seg } });
  }
}

// 菱形节点（按状态色填充）
function DiamondNode({ data, selected }) {
  const fill = data.fill || STATUS_FALLBACK;
  const text = data.text || '#ffffff';
  return (
    <div className="dnode" style={{ width: DIAMOND_W, height: DIAMOND_H }} title={data.name || ''}>
      <Handle type="target" position={Position.Left} className="dhandle" />
      <svg width={DIAMOND_W} height={DIAMOND_H} viewBox={`0 0 ${DIAMOND_W} ${DIAMOND_H}`}>
        <polygon
          points={`${DIAMOND_W / 2},2 ${DIAMOND_W - 2},${DIAMOND_H / 2} ${DIAMOND_W / 2},${DIAMOND_H - 2} 2,${DIAMOND_H / 2}`}
          fill={fill}
          stroke={selected ? '#378ADD' : 'rgba(0,0,0,0.18)'}
          strokeWidth={selected ? 2.5 : 1}
        />
      </svg>
      <div className="dinner">
        <span className="dcode" style={{ color: text }}>{data.code || '—'}</span>
        <span className="dname" style={{ color: text }}>{data.name || ''}</span>
      </div>
      <Handle type="source" position={Position.Right} className="dhandle" />
    </div>
  );
}

// 矩形工序节点（按状态色填充）
function RectNode({ data, selected }) {
  const fill = data.fill || STATUS_FALLBACK;
  const text = data.text || '#ffffff';
  return (
    <div
      className="rnode"
      style={{
        width: DIAMOND_W,
        height: DIAMOND_H,
        background: fill,
        borderColor: selected ? '#378ADD' : 'rgba(0,0,0,0.15)',
      }}
    >
      <Handle type="target" position={Position.Left} className="dhandle" />
      <div className="dinner">
        <span className="dcode" style={{ color: text }}>{data.code || '—'}</span>
        <span className="dname" style={{ color: text }}>{data.name || ''}</span>
      </div>
      <Handle type="source" position={Position.Right} className="dhandle" />
    </div>
  );
}

// 分组标签节点（板块色，保持不变）
function LabelNode({ data }) {
  const pc = PLATE_COLOR[data.plate] || PLATE_COLOR['(未分板块)'];
  return (
    <div className="lnode" style={{ background: pc.fill, borderColor: pc.stroke, color: pc.text, width: LABEL_W, height: DIAMOND_H }}>
      {data.label}
      <Handle type="source" position={Position.Right} className="dhandle" />
    </div>
  );
}

// 结束节点
function EndNode() {
  return (
    <div className="enode" style={{ width: 80, height: 48 }}>
      <Handle type="target" position={Position.Left} className="dhandle" />
      结束
    </div>
  );
}

// 开始节点
function StartNode() {
  return (
    <div className="snode" style={{ width: 80, height: 48 }}>
      <Handle type="target" position={Position.Left} className="dhandle" />
      开始
      <Handle type="source" position={Position.Right} className="dhandle" />
    </div>
  );
}

const nodeTypes = { diamond: DiamondNode, rect: RectNode, label: LabelNode, end: EndNode, start: StartNode };

export default function App() {
  const [state, setState] = useState({ loading: true, error: null, items: [] });
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState(null);
  const [dashState, setDashState] = useState(null);
  const [showShapeMenu, setShowShapeMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  const statusInfo = useMemo(() => buildStatusMap(state.items), [state.items]);
  const statusMap = statusInfo.map;
  const statusOrder = statusInfo.order;

  const load = useCallback(async () => {
    try {
      const table = await bitable.base.getTableById(TABLE_ID);
      const plateField = await table.getFieldByName('板块');
      const codeField = await table.getFieldByName('编号');
      const nameField = await table.getFieldByName('测试项');
      const statusField = await table.getFieldByName('状态').catch(() => null);
      const records = await readAllRecords(table);
      const items = records.map((r) => ({
        recordId: r.recordId,
        plate: getSelect(r.fields[plateField.id]),
        code: getText(r.fields[codeField.id]),
        name: getText(r.fields[nameField.id]),
        status: statusField ? getSelect(r.fields[statusField.id]) : '',
      }));
      setState({ loading: false, error: null, items });

      const smap = buildStatusMap(items);

      // 优先读飞书表草稿
      let draft = null;
      try {
        draft = await loadDraftFromTable();
      } catch (e) {
        /* ignore */
      }

      if (draft) {
        setNodes(relayoutDraft(normalizeDraftColors(draft.nodes, smap.map)));
        setEdges((draft.edges || []).map((e) => ({ ...e, type: 'straight' })));
        setMsg('已加载已保存的编辑结果（已自动重排布局）');
      } else {
        const init = buildInitial(items, smap.map);
        setNodes(init.nodes);
        setEdges(init.edges);
        setMsg('已从「测试项总表」生成（相同编号已合并，按状态着色）');
      }
    } catch (e) {
      setState({ loading: false, error: String((e && e.message) || e), items: [] });
    }
  }, [setNodes, setEdges]);

  // 感知仪表盘插件状态（Create/Config/View/FullScreen）
  useEffect(() => {
    try {
      setDashState(dashboard.state);
    } catch (e) {
      setDashState('');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onConnect = useCallback((params) => setEdges((eds) => addEdge(params, eds)), [setEdges]);

  const onNodeDoubleClick = useCallback((_e, node) => {
    if (node.type === 'diamond' || node.type === 'rect') {
      const d = node.data || {};
      setEditing({ type: node.type, id: node.id, code: d.code || '', name: d.name || '', status: d.status || '', recordId: d.recordId || '' });
    } else if (node.type === 'label') {
      const d = node.data || {};
      setEditing({ type: 'label', id: node.id, label: d.label || '' });
    }
  }, []);

  const updateNode = useCallback(() => {
    if (!editing) return;
    if (editing.type === 'label') {
      setNodes((cur) =>
        cur.map((n) => (n.id === editing.id ? { ...n, data: { ...n.data, label: editing.label } } : n))
      );
    } else {
      const smap = buildStatusMap(state.items);
      const fill = (editing.status && smap.map[editing.status]) || STATUS_FALLBACK;
      setNodes((cur) =>
        cur.map((n) =>
          n.id === editing.id
            ? { ...n, data: { ...n.data, code: editing.code, name: editing.name, status: editing.status, fill, text: '#ffffff' } }
            : n
        )
      );
    }
    setEditing(null);
    setMsg('已更新节点内容（记得点保存）');
  }, [editing, state.items, setNodes]);

  const addShape = useCallback(
    (type) => {
      setShowShapeMenu(false);
      const ns = nodesRef.current;
      const maxX = ns.length ? ns.reduce((m, n) => Math.max(m, n.position.x), 0) : 0;
      const maxY = ns.length ? ns.reduce((m, n) => Math.max(m, n.position.y), 0) : 0;
      const id = `${type}-${Date.now()}`;
      let node;
      if (type === 'diamond') {
        node = { id, type: 'diamond', position: { x: maxX + STEP_X, y: maxY }, data: { code: '', name: '新工序', status: '', plate: '', recordId: '', fill: STATUS_FALLBACK, text: '#ffffff' } };
      } else if (type === 'rect') {
        node = { id, type: 'rect', position: { x: maxX + STEP_X, y: maxY }, data: { code: '', name: '新工序', status: '', fill: STATUS_FALLBACK, text: '#ffffff' } };
      } else if (type === 'start') {
        node = { id, type: 'start', position: { x: maxX + STEP_X, y: maxY }, data: {} };
      } else if (type === 'end') {
        node = { id, type: 'end', position: { x: maxX + STEP_X, y: maxY }, data: {} };
      } else if (type === 'label') {
        node = { id, type: 'label', position: { x: maxX + STEP_X, y: maxY }, data: { label: '新分组', plate: '' } };
      } else {
        return;
      }
      setNodes((cur) => [...cur, node]);
      setMsg('已添加一个图形，可拖拽、双击编辑');
    },
    [setNodes]
  );

  const save = useCallback(async () => {
    try {
      await saveDraftToTable(nodesRef.current, edgesRef.current);
      setMsg('已保存到飞书表');
    } catch (e) {
      setMsg('保存失败：' + String((e && e.message) || e));
    }
  }, []);

  const reset = useCallback(async () => {
    const smap = buildStatusMap(state.items);
    const init = buildInitial(state.items, smap.map);
    setNodes(init.nodes);
    setEdges(init.edges);
    setMsg('已重置为「测试项总表」的自动生成结果');
  }, [state.items, setNodes, setEdges]);

  // 配置态：点「确定」保存配置（数据源固定为测试项总表），飞书据此完成添加
  const handleConfirm = useCallback(async () => {
    try {
      await dashboard.saveConfig({
        dataConditions: {
          tableId: TABLE_ID,
          dataRange: { type: SourceType.ALL },
          series: 'COUNTA',
          groups: [],
        },
      });
    } catch (e) {
      setMsg('保存配置失败：' + String((e && e.message) || e));
    }
  }, []);

  const isConfig = dashState === DashboardState.Create || dashState === DashboardState.Config;

  if (state.loading) return <div className="tip">正在加载工艺路线数据…</div>;
  if (state.error) return <div className="tip error">加载失败：{state.error}</div>;

  // 配置态（创建/配置）：渲染说明 + 右下角「确定」按钮
  if (isConfig) {
    return (
      <div className="app">
        <div className="config-panel">
          <div className="config-title">F050 产测工艺路线导图</div>
          <div className="config-desc">数据源固定为「测试项总表」，点击右下角「确定」将流程图添加到仪表盘。</div>
        </div>
        <button className="config-confirm" onClick={handleConfirm}>确定</button>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="header">
        <span className="h-title">F050 产测工艺路线导图</span>
        <button className="btn h-toggle" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? '展开' : '收起'}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="toolbar">
            <div className="t-actions">
              <div className="shape-wrap">
                <button className="btn" onClick={() => setShowShapeMenu((v) => !v)}>＋ 添加图形</button>
                {showShapeMenu && (
                  <div className="shape-menu">
                    <button onClick={() => addShape('diamond')}>菱形（工序）</button>
                    <button onClick={() => addShape('rect')}>矩形（工序）</button>
                    <button onClick={() => addShape('start')}>开始</button>
                    <button onClick={() => addShape('end')}>结束</button>
                    <button onClick={() => addShape('label')}>分组标签</button>
                  </div>
                )}
              </div>
              <button className="btn btn-primary" onClick={save}>保存</button>
              <button className="btn" onClick={reset}>重置</button>
            </div>
          </div>
          <div className="t-msg">{msg}</div>
          <div className="legend">
            {statusOrder.map((s) => (
              <span className="legend-item" key={s}>
                <i className="lg-dot" style={{ background: statusMap[s] }} />
                {s}
              </span>
            ))}
            <span className="legend-tip">拖拽移动 · 点选后按 Delete 删除 · 双击编辑 · 从节点边缘拖出连线</span>
          </div>
        </>
      )}
      <div className="flow-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDoubleClick={onNodeDoubleClick}
          nodeTypes={nodeTypes}
          minZoom={0.7}
          defaultEdgeOptions={{ style: { strokeWidth: 2.5, stroke: '#6b6a65' }, markerEnd: { type: MarkerType.ArrowClosed, width: 10, height: 10, color: '#6b6a65' } }}
          fitView
          fitViewOptions={{ padding: 0.1 }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      {editing && (
        <div className="edit-mask" onClick={() => setEditing(null)}>
          <div className="edit-panel" onClick={(e) => e.stopPropagation()}>
            {editing.type === 'label' ? (
              <>
                <div className="edit-title">编辑分组标签</div>
                <label>名称</label>
                <input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} placeholder="如 FCT板级" />
              </>
            ) : (
              <>
                <div className="edit-title">编辑工序</div>
                <label>编号</label>
                <input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} placeholder="如 C6" />
                <label>名称</label>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如 XY电机扭矩测试" />
                <label>状态</label>
                <div className="edit-status">
                  <span
                    className={`st-chip${!editing.status ? ' on' : ''}`}
                    style={!editing.status ? { background: STATUS_FALLBACK, color: '#fff' } : {}}
                    onClick={() => setEditing({ ...editing, status: '' })}
                  >
                    无
                  </span>
                  {statusOrder.map((s) => (
                    <span
                      key={s}
                      className={`st-chip${editing.status === s ? ' on' : ''}`}
                      style={editing.status === s ? { background: statusMap[s], color: '#fff' } : {}}
                      onClick={() => setEditing({ ...editing, status: s })}
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </>
            )}
            <div className="edit-btns">
              {editing.recordId ? (
                <button
                  className="btn"
                  onClick={() => bitable.ui.showRecordDetailDialog({ tableId: TABLE_ID, recordId: editing.recordId }).catch(() => {})}
                >
                  打开记录
                </button>
              ) : null}
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn btn-primary" onClick={updateNode}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
