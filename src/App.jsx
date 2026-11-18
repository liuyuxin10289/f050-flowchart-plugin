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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const TABLE_ID = 'tblo7aujbBBknvBE'; // 测试项总表
const DRAFT_TABLE_ID = 'tblUAqCjDSj0Dmrm'; // 流程图草稿表
const PLATE_ORDER = ['FCT板级', '组件', '整机自检', '整机产测', '模型打印'];

const STATUS_COLOR = {
  已有做法: '#2E7D32',
  待确认: '#EF9F27',
  缺口: '#E24B4A',
};

const PLATE_COLOR = {
  FCT板级: { fill: '#B5D4F4', stroke: '#185FA5', text: '#0C447C' },
  组件: { fill: '#C0DD97', stroke: '#3B6D11', text: '#27500A' },
  整机自检: { fill: '#FAC775', stroke: '#854F0B', text: '#633806' },
  整机产测: { fill: '#CECBF6', stroke: '#534AB7', text: '#3C3489' },
  模型打印: { fill: '#F7C1C1', stroke: '#A32D2D', text: '#791F1F' },
  '(未分板块)': { fill: '#D3D1C7', stroke: '#5F5E5A', text: '#444441' },
};

const STEP_X = 140;
const STEP_Y = 92;
const LABEL_W = 84;

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

// 由表数据生成初始横向泳道图
function buildInitial(items) {
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
    let cx = LABEL_W + 14;
    const startId = `start-${plate}`;
    nodes.push({ id: startId, type: 'start', position: { x: cx, y: y + 8 }, data: {} });
    edges.push({ id: `e-${labelId}-${startId}`, source: labelId, target: startId, type: 'smoothstep' });
    cx += 60 + 14;

    let prevId = startId;
    list.forEach((it) => {
      const id = `${plate}|${it.code || it.name}`;
      nodes.push({
        id,
        type: 'diamond',
        position: { x: cx, y },
        data: { code: it.code, name: it.name, status: it.status, plate, recordId: it.recordId },
      });
      edges.push({ id: `e-${prevId}-${id}`, source: prevId, target: id, type: 'smoothstep' });
      prevId = id;
      cx += 112 + 14;
    });

    const endId = `end-${plate}`;
    nodes.push({ id: endId, type: 'end', position: { x: cx, y: y + 8 }, data: {} });
    edges.push({ id: `e-${prevId}-${endId}`, source: prevId, target: endId, type: 'smoothstep' });
  });
  return { nodes, edges };
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

// 菱形节点
function DiamondNode({ data, selected }) {
  const pc = PLATE_COLOR[data.plate] || PLATE_COLOR['(未分板块)'];
  return (
    <div className="dnode" style={{ width: 112, height: 56 }} title={data.name || ''}>
      <Handle type="target" position={Position.Left} className="dhandle" />
      <svg width="112" height="56" viewBox="0 0 112 56">
        <polygon
          points="56,2 110,28 56,54 2,28"
          fill={pc.fill}
          stroke={selected ? '#378ADD' : pc.stroke}
          strokeWidth={selected ? 2.5 : 1.5}
        />
      </svg>
      <div className="dinner">
        <span className="dcode" style={{ color: pc.text }}>{data.code || '—'}</span>
        <span className="dname">{data.name || ''}</span>
      </div>
      <Handle type="source" position={Position.Right} className="dhandle" />
    </div>
  );
}

// 分组标签节点
function LabelNode({ data }) {
  const pc = PLATE_COLOR[data.plate] || PLATE_COLOR['(未分板块)'];
  return (
    <div className="lnode" style={{ background: pc.fill, borderColor: pc.stroke, color: pc.text, width: LABEL_W, height: 56 }}>
      {data.label}
      <Handle type="source" position={Position.Right} className="dhandle" />
    </div>
  );
}

// 结束节点
function EndNode() {
  return (
    <div className="enode" style={{ width: 60, height: 40 }}>
      <Handle type="target" position={Position.Left} className="dhandle" />
      结束
    </div>
  );
}

// 开始节点
function StartNode() {
  return (
    <div className="snode" style={{ width: 60, height: 40 }}>
      <Handle type="target" position={Position.Left} className="dhandle" />
      开始
      <Handle type="source" position={Position.Right} className="dhandle" />
    </div>
  );
}

const nodeTypes = { diamond: DiamondNode, label: LabelNode, end: EndNode, start: StartNode };

export default function App() {
  const [state, setState] = useState({ loading: true, error: null, items: [] });
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState(null);
  const [dashState, setDashState] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

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

      // 优先读飞书表草稿
      let draft = null;
      try {
        draft = await loadDraftFromTable();
      } catch (e) {
        /* ignore */
      }

      if (draft) {
        setNodes(draft.nodes);
        setEdges(draft.edges || []);
        setMsg('已加载已保存的编辑结果');
      } else {
        const init = buildInitial(items);
        setNodes(init.nodes);
        setEdges(init.edges);
        setMsg('已从「测试项总表」生成（相同编号已合并）');
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
    if (node.type !== 'diamond') return;
    const d = node.data || {};
    setEditing({ id: node.id, code: d.code || '', name: d.name || '', status: d.status || '', recordId: d.recordId || '' });
  }, []);

  const updateNode = useCallback(() => {
    if (!editing) return;
    setNodes((cur) =>
      cur.map((n) =>
        n.id === editing.id
          ? { ...n, data: { ...n.data, code: editing.code, name: editing.name, status: editing.status } }
          : n
      )
    );
    setEditing(null);
    setMsg('已更新节点内容（记得点保存）');
  }, [editing, setNodes]);

  const addNode = useCallback(() => {
    const ns = nodesRef.current;
    const maxX = ns.reduce((m, n) => Math.max(m, n.position.x), 0);
    const last = ns[ns.length - 1];
    const y = last ? last.position.y : 0;
    const id = `new-${Date.now()}`;
    setNodes((cur) => [...cur, { id, type: 'diamond', position: { x: maxX + STEP_X, y }, data: { code: '', name: '新工序', status: '', plate: '', recordId: '' } }]);
    if (last) {
      setEdges((eds) => [...eds, { id: `e-${last.id}-${id}`, source: last.id, target: id, type: 'smoothstep' }]);
    }
    setMsg('已添加一个菱形，可拖拽/双击删除');
  }, [setNodes, setEdges]);

  const save = useCallback(async () => {
    try {
      await saveDraftToTable(nodesRef.current, edgesRef.current);
      setMsg('已保存到飞书表');
    } catch (e) {
      setMsg('保存失败：' + String((e && e.message) || e));
    }
  }, []);

  const reset = useCallback(async () => {
    const init = buildInitial(state.items);
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
      <div className="toolbar">
        <div className="t-title">F050 产测工艺路线导图</div>
        <div className="t-actions">
          <button className="btn" onClick={addNode}>＋ 添加菱形</button>
          <button className="btn btn-primary" onClick={save}>保存</button>
          <button className="btn" onClick={reset}>重置</button>
        </div>
      </div>
      <div className="t-msg">{msg}</div>
      <div className="legend">
        <span className="legend-item"><i className="lg-dot" style={{ background: STATUS_COLOR['已有做法'] }} />已有做法</span>
        <span className="legend-item"><i className="lg-dot" style={{ background: STATUS_COLOR['待确认'] }} />待确认</span>
        <span className="legend-item"><i className="lg-dot" style={{ background: STATUS_COLOR['缺口'] }} />缺口</span>
        <span className="legend-tip">拖拽移动 · 点选后按 Delete 删除 · 双击跳记录 · 从节点边缘拖出连线</span>
      </div>
      <div className="flow-wrap">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDoubleClick={onNodeDoubleClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      {editing && (
        <div className="edit-mask" onClick={() => setEditing(null)}>
          <div className="edit-panel" onClick={(e) => e.stopPropagation()}>
            <div className="edit-title">编辑菱形</div>
            <label>编号</label>
            <input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} placeholder="如 C6" />
            <label>名称</label>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如 XY电机扭矩测试" />
            <label>状态</label>
            <div className="edit-status">
              {['已有做法', '待确认', '缺口'].map((s) => (
                <span
                  key={s}
                  className={`st-chip${editing.status === s ? ' on' : ''}`}
                  style={editing.status === s ? { background: STATUS_COLOR[s], color: '#fff' } : {}}
                  onClick={() => setEditing({ ...editing, status: s })}
                >
                  {s}
                </span>
              ))}
            </div>
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
