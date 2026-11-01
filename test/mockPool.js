// In-memory mock PostgreSQL pool for integration tests.
// Understands the subset of PostgreSQL used by afrocoinmoney routes.
'use strict';

var TABLE_NAMES = ['users','bots','user_bots','transactions','tasks','user_tasks','daily_earnings','referral_bonuses','platform_settings','notifications','platform_fees','system_logs','tickets','withdrawal_addresses'];
var SQL_KEYWORDS = /^(WHERE|ORDER|LIMIT|GROUP|HAVING|JOIN|INNER|LEFT|RIGHT|OUTER|ON|AND|OR|SET|VALUES|RETURNING|UNION)$/i;

function fillParams(sql, params) {
  if (!params || !params.length) return sql;
  var result = sql;
  for (var i = params.length; i >= 1; i--) {
    var raw = params[i - 1], lit;
    if (raw === null || raw === undefined) lit = 'NULL';
    else if (typeof raw === 'number') lit = String(raw);
    else if (typeof raw === 'boolean') lit = raw ? 'TRUE' : 'FALSE';
    else lit = "'" + String(raw).replace(/'/g, "''") + "'";
    result = result.replace(new RegExp('\\$' + i + '\\b', 'g'), lit);
  }
  return result;
}

function parseLiteral(raw) {
  var s = String(raw).trim();
  if (!s || s === 'NULL') return null;
  if (/^TRUE$/i.test(s)) return true;
  if (/^FALSE$/i.test(s)) return false;
  if (s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (!isNaN(Number(s))) return Number(s);
  return s;
}

// Strip a table alias prefix: "u.referred_by" -> "referred_by"
function colOf(token) {
  var s = String(token).trim();
  var i = s.lastIndexOf('.');
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

function evalCondition(cond, row) {
  cond = cond.trim();
  while (cond[0] === '(' && cond[cond.length - 1] === ')') cond = cond.slice(1, -1).trim();
  var m;
  m = cond.match(/^([\w.]+)\s+IS\s+NOT\s+NULL\s*$/i);
  if (m) return row[colOf(m[1])] != null;
  m = cond.match(/^([\w.]+)\s+IS\s+NULL\s*$/i);
  if (m) return row[colOf(m[1])] == null;
  m = cond.match(/^([\w.]+)\s+IN\s*\((.+)\)$/i);
  if (m) {
    var vals = m[2].split(',').map(function(v){return parseLiteral(v.trim());});
    return vals.indexOf(row[colOf(m[1])]) !== -1;
  }
  m = cond.match(/^([\w.]+)\s*(=|!=|<>|<=|>=|<|>)\s*(.+)$/i);
  if (m) {
    var a = row[colOf(m[1])], e = parseLiteral(m[3].trim());
    switch (m[2]) {
      case '=': return a == e;
      case '!=': case '<>': return a != e;
      case '<': return Number(a) < Number(e);
      case '>': return Number(a) > Number(e);
      case '<=': return Number(a) <= Number(e);
      case '>=': return Number(a) >= Number(e);
    }
  }
  return true;
}

// Split WHERE on top-level AND (quote/paren aware)
function splitAnd(whereStr) {
  var parts = [], depth = 0, inStr = false, qc = '', cur = '';
  for (var i = 0; i < whereStr.length; i++) {
    var ch = whereStr[i];
    if (inStr) { cur += ch; if (ch === qc) inStr = false; continue; }
    if (ch === "'" || ch === '"') { inStr = true; qc = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && whereStr.slice(i, i + 4).toUpperCase() === ' AND') { parts.push(cur); cur = ''; i += 3; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.filter(function(p){return p.trim().length>0;});
}

function evalWhere(whereStr, row) {
  if (!whereStr) return true;
  return splitAnd(whereStr).every(function(c){return evalCondition(c, row);});
}

function evalSetExpr(expr, row) {
  expr = expr.trim();
  var m;
  m = expr.match(/^GREATEST\s*\(\s*([\w.]+)\s*-\s*([\d.]+)\s*,\s*0\s*\)$/i);
  if (m) return Math.max(Number(row[colOf(m[1])]||0) - parseFloat(m[2]), 0);
  m = expr.match(/^([\w.]+)\s*\+\s*([\d.]+)$/);
  if (m) return Number(row[colOf(m[1])]||0) + parseFloat(m[2]);
  m = expr.match(/^([\w.]+)\s*-\s*([\d.]+)$/);
  if (m) return Number(row[colOf(m[1])]||0) - parseFloat(m[2]);
  m = expr.match(/^CASE\s+WHEN\s+([\w.]+)\s*=\s*(.+?)\s+THEN\s+(.+?)\s+ELSE\s+(.+?)\s+END$/i);
  if (m) return row[colOf(m[1])] == parseLiteral(m[2].trim()) ? parseLiteral(m[3].trim()) : parseLiteral(m[4].trim());
  return parseLiteral(expr);
}

// Split a comma-separated list respecting quotes and parens.
function splitTop(str) {
  var out = [], depth = 0, inStr = false, qc = '', cur = '';
  for (var i = 0; i < str.length; i++) {
    var ch = str[i];
    if (inStr) { cur += ch; if (ch === qc) inStr = false; continue; }
    if (ch === "'" || ch === '"') { inStr = true; qc = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(function(s){return s.trim();}).filter(function(s){return s.length>0;});
}

function execInsert(sql, tables, counters) {
  var m = sql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)\s*(?:RETURNING|\s|ON|$)/i);
  if (!m) return { rows: [], rowCount: 0 };
  var table = m[1].toLowerCase();
  var cols = m[2].split(',').map(function(c){return c.trim().replace(/['"]/g,'').toLowerCase();});
  var valStr = m[3];

  // ON CONFLICT ... DO NOTHING
  var cm = sql.match(/ON\s+CONFLICT\s*\(([^)]+)\)/i);
  if (cm && /DO\s+NOTHING/i.test(sql)) {
    var ccols = cm[1].split(',').map(function(c){return c.trim().replace(/['"]/g,'').toLowerCase();});
    var cv = {};
    splitTop(valStr).forEach(function(v,i){ cv[cols[i]] = parseLiteral(v); });
    var dup = tables[table].some(function(r){ return ccols.every(function(c){ return r[c] == cv[c]; }); });
    if (dup) return { rows: [], rowCount: 0 };
  }

  var vals = splitTop(valStr);
  var row = {};
  cols.forEach(function(c,i){ row[c] = vals[i] !== undefined ? parseLiteral(vals[i]) : null; });

  var defaults = { users:['wallet_balance','total_deposited','total_withdrawn','bot_income','team_income','pending_earnings'],
                   transactions:['fee','net_amount'] };
  (defaults[table] || []).forEach(function(k){ if (row[k] === undefined) row[k] = 0; });

  if (!row.id) row.id = counters[table]++;
  if (!row.created_at) row.created_at = new Date().toISOString();
  if (row.status === undefined && table !== 'platform_settings' && table !== 'bots') row.status = 'pending';

  tables[table].push(row);
  if (/RETURNING\s+\*/i.test(sql)) return { rows: [row], rowCount: 1 };
  return { rows: [], rowCount: 1 };
}

function execUpdate(sql, tables) {
  var hasReturn = /RETURNING\s+\*/i.test(sql);
  var m = sql.match(/UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+RETURNING\s+\*)?\s*$/i);
  if (!m) return { rows: [], rowCount: 0 };
  var table = m[1].toLowerCase();
  var rows = tables[table] || [];
  var assignments = splitTop(m[2]).map(function(part){
    var sm = part.match(/^([\w.]+)\s*=\s*([\s\S]+)$/i);
    return sm ? { col: colOf(sm[1]), expr: sm[2].trim() } : null;
  }).filter(Boolean);
  var updated = [];
  rows.forEach(function(row){
    if (!evalWhere(m[3] || '', row)) return;
    assignments.forEach(function(a){ row[a.col] = evalSetExpr(a.expr, row); });
    updated.push(row);
  });
  if (hasReturn) return { rows: updated, rowCount: updated.length };
  return { rows: [], rowCount: updated.length };
}

function execDelete(sql, tables) {
  var m = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+([\s\S]+))?\s*$/i);
  if (!m) return { rows: [], rowCount: 0 };
  var rows = tables[m[1].toLowerCase()] || [];
  var kept = rows.filter(function(r){ return !evalWhere(m[2] || '', r); });
  var deleted = rows.length - kept.length;
  tables[m[1].toLowerCase()] = kept;
  return { rows: [], rowCount: deleted };
}

// Evaluate a JOIN ON condition for primary row `r` and joined row `j`.
// Handles "a.x = b.y" (resolve sides by alias) and "a.x = <literal>".
function joinCondOk(cond, r, j, pAlias, jAlias) {
  cond = cond.trim();
  var m = cond.match(/^([\w.]+)\s*=\s*(?:([\w.]+)|(.+))$/i);
  if (!m) return true;
  var left = m[1], right = m[2] !== undefined ? m[2] : null, lit = m[3];

  if (right !== null) {
    // both are column refs
    var lAlias = left.indexOf('.') >= 0 ? left.split('.')[0] : null;
    var rAlias = right.indexOf('.') >= 0 ? right.split('.')[0] : null;
    var lv, rv;
    if (lAlias && lAlias.toLowerCase() === String(jAlias).toLowerCase()) lv = j[colOf(left)];
    else lv = r[colOf(left)];
    if (rAlias && rAlias.toLowerCase() === String(jAlias).toLowerCase()) rv = j[colOf(right)];
    else rv = r[colOf(right)];
    return lv == rv || Number(lv) === Number(rv);
  }
  // literal comparison — decide side by alias
  var alias = left.indexOf('.') >= 0 ? left.split('.')[0] : null;
  if (alias && alias.toLowerCase() === String(jAlias).toLowerCase()) return j[colOf(left)] == parseLiteral(lit.trim());
  return r[colOf(left)] == parseLiteral(lit.trim());
}

function applyJoin(rows, pAlias, joinTable, jAlias, joinOnStr, tables) {
  var jr = (tables[joinTable] || []).slice();
  var isLeft = /^\s*LEFT/i.test(joinOnStr);
  var onClause = joinOnStr.replace(/^\s*(?:LEFT\s+|INNER\s+)?JOIN\s+\w+\s+(?:\w+)\s+ON\s+/i, '');
  var conds = splitAnd(onClause);
  var out = [];
  rows.forEach(function(r){
    var matched = jr.filter(function(j){ return conds.every(function(c){ return joinCondOk(c, r, j, pAlias, jAlias); }); });
    if (matched.length) matched.forEach(function(j){ out.push(Object.assign({}, r, j)); });
    else if (isLeft) out.push(Object.assign({}, r));
  });
  return out;
}

function applyOrder(rows, orderStr) {
  var clauses = splitTop(orderStr);
  rows.sort(function(a, b) {
    for (var i = 0; i < clauses.length; i++) {
      var clause = clauses[i];
      var isNotNull = /IS\s+NOT\s+NULL/i.test(clause);
      var mm = clause.match(/([\w.]+)/);
      if (!mm) continue;
      var col = colOf(mm[1]);
      var dir = /\bDESC\b/i.test(clause) ? -1 : 1;
      var va = isNotNull ? (a[col] != null ? 1 : 0) : a[col];
      var vb = isNotNull ? (b[col] != null ? 1 : 0) : b[col];
      if (va === vb) continue;
      if (typeof va === 'string' && typeof vb === 'string') return va < vb ? -dir : dir;
      return Number(va) < Number(vb) ? -dir : dir;
    }
    return 0;
  });
  return rows;
}

function execSelect(sql, tables) {
  // COUNT(*) AS c  (alias group must not swallow WHERE/ORDER/...)
  var m = sql.match(/^SELECT\s+COUNT\(\*\)\s*(?:::\s*int)?\s+AS\s+(\w+)\s+FROM\s+(\w+)\s*([\w.]*)([\s\S]*)$/i);
  if (m && /^count\(\*\)/i.test(sql.trim().replace(/^SELECT\s+/i, ''))) {
    var tail = m[3] && !SQL_KEYWORDS.test(m[3]) ? m[4] : (m[3] || '') + m[4];
    var cnt = (tables[m[2].toLowerCase()] || []).filter(function(r){ return evalWhere(extractWhere(tail), r); }).length;
    return { rows: [{ c: cnt }], rowCount: 1 };
  }
  // COUNT(DISTINCT alias.col) AS c ... JOIN ... ON ... WHERE ...
  m = sql.match(/SELECT\s+COUNT\(\s*DISTINCT\s+([\w.]+)\s*\)\s*(?:::\s*int)?\s+AS\s+(\w+)\s+FROM\s+(\w+)\s*(\w*)([\s\S]*)$/i);
  if (m) {
    var prim = m[3].toLowerCase();
    var pAl = SQL_KEYWORDS.test(m[4]) ? null : m[4];
    var rest = SQL_KEYWORDS.test(m[4]) ? m[4] : (m[5] || '');
    var jm = rest.match(/(?:LEFT\s+|INNER\s+)?JOIN\s+(\w+)\s+(\w+)\s+ON\s+([\s\S]+?)(?=\s+WHERE\b|\s+ORDER\b|\s+LIMIT\b|$)/i);
    var whereStr = extractWhere(rest);
    var pr = tables[prim] || [];
    var ids = {};
    pr.forEach(function(u){
      if (whereStr && !evalWhere(whereStr, u)) return;
      if (!jm) { ids[u.id] = true; return; }
      var jrAll = tables[jm[1].toLowerCase()] || [];
      var ok = jrAll.some(function(j){
        return splitAnd(jm[3]).every(function(c){ return joinCondOk(c, u, j, pAl || prim, jm[2]); });
      });
      if (ok) ids[u.id] = true;
    });
    return { rows: [{ c: Object.keys(ids).length }], rowCount: 1 };
  }
  // COALESCE(SUM(a)+SUM(b),0) AS x
  m = sql.match(/SELECT\s+COALESCE\s*\(\s*SUM\s*\(\s*(\w+)\s*\)\s*\+\s*SUM\s*\(\s*(\w+)\s*\)\s*,\s*0\s*\)\s+AS\s+(\w+)\s+FROM\s+(\w+)/i);
  if (m) {
    var t = m[4].toLowerCase();
    var sum = tables[t].reduce(function(a,r){return a+Number(r[m[1]]||0);},0)
             + tables[t].reduce(function(a,r){return a+Number(r[m[2]]||0);},0);
    return { rows: [{ [m[3]]: sum }], rowCount: 1 };
  }

  // ---- Generic SELECT -----------------------------------------------------
  m = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)\s*([\s\S]*)$/i);
  if (!m) return { rows: [], rowCount: 0 };
  var colStr = m[1].trim();
  var table = m[2].toLowerCase();
  var rest2 = m[3] || '';

  // Leading table alias (skip SQL keywords like WHERE/ORDER...)
  var pAlias = table;
  var am = rest2.match(/^\s+([A-Za-z_]\w*)((?:\s[\s\S]*)?)$/);
  if (am && !SQL_KEYWORDS.test(am[1])) { pAlias = am[1]; rest2 = am[2] || ''; }
  else rest2 = rest2.replace(/^\s+/, '');

  var rows = (tables[table] || []).slice();

  // JOIN
  var jm2 = rest2.match(/((?:LEFT\s+|INNER\s+)?JOIN\s+\w+\s+\w+\s+ON\s+[\s\S]+?)(?=\s+WHERE\b|\s+ORDER\b|\s+LIMIT\b|\s*;|$)/i);
  if (jm2) {
    var parts = jm2[1].match(/(LEFT\s+|INNER\s+)?JOIN\s+(\w+)\s+(\w+)\s+ON\s+([\s\S]+)/i);
    rows = applyJoin(rows, pAlias, parts[2].toLowerCase(), parts[3], (parts[1]||'') + 'JOIN ' + parts[2] + ' ' + parts[3] + ' ON ' + parts[4], tables);
    rest2 = rest2.replace(jm2[1], ' ');
  }

  // WHERE
  var wm = rest2.match(/\bWHERE\b\s+([\s\S]+?)(?=\s+ORDER\s+BY\b|\s+LIMIT\b|\s+FOR\s+UPDATE\b|\s*;|$)/i);
  if (wm) rows = rows.filter(function(r){ return evalWhere(wm[1], r); });

  // ORDER BY
  var om = sql.match(/\bORDER\s+BY\s+([\s\S]+?)(?=\s+LIMIT\b|\s*;|$)/i);
  if (om) rows = applyOrder(rows, om[1]);

  // LIMIT
  var lm = sql.match(/\bLIMIT\s+(\d+)/i);
  if (lm) rows = rows.slice(0, parseInt(lm[1], 10));

  // Projection — pg names bare columns without the alias prefix; every listed
  // column appears in the result (null when a LEFT JOIN missed).
  if (!/^\*$/.test(colStr)) {
    rows = rows.map(function(r){
      var p = {};
      splitTop(colStr).forEach(function(tok){
        var asM = tok.match(/^([\w.*]+)\s+AS\s+(\w+)$/i);
        if (asM) {
          var srcA = colOf(asM[1]);
          p[asM[2].toLowerCase()] = (srcA === '*' || srcA === '') ? (r[asM[2].toLowerCase()] ?? null) : r[srcA];
          return;
        }
        if (/^[\w.]*\*$/.test(tok)) { Object.keys(r).forEach(function(k){ p[k] = r[k]; }); return; }
        var key = colOf(tok);
        p[key] = r[key] !== undefined ? r[key] : null;
      });
      return p;
    });
  }
  return { rows: rows, rowCount: rows.length };
}

// Extract just the WHERE-clause text from a trailing SQL fragment.
function extractWhere(fragment) {
  if (!fragment) return null;
  var wm = fragment.match(/\bWHERE\b\s+([\s\S]+?)(?=\s+ORDER\s+BY\b|\s+LIMIT\b|\s+FOR\s+UPDATE\b|\s*;|$)/i);
  return wm ? wm[1] : null;
}

function createMockPool(seedBots, seedTasks) {
  var tables = {};
  var counters = {};
  TABLE_NAMES.forEach(function(t){ tables[t] = []; counters[t] = 1; });

  if (seedBots) seedBots.forEach(function(b){
    tables.bots.push({ id: counters.bots++, name: b.name, tier: b.tier,
      min_amount: b.price, max_amount: b.price, daily_percent: b.daily_percent,
      lock_days: b.lock_days, sort_order: b.sort_order });
  });
  if (seedTasks) seedTasks.forEach(function(t){
    tables.tasks.push({ id: counters.tasks++, title: t.title, description: t.description,
      reward: t.reward, condition: t.condition, sort_order: t.sort_order });
  });

  function doQuery(sql, params) {
    var filled = fillParams(sql, params || []);
    if (/^\s*(CREATE|ALTER|DROP|CREATE\s+INDEX)/i.test(filled)) return { rows: [], rowCount: 0 };
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i.test(filled)) return { rows: [], rowCount: 0 };
    if (/^\s*INSERT/i.test(filled)) return execInsert(filled, tables, counters);
    if (/^\s*UPDATE/i.test(filled)) return execUpdate(filled, tables);
    if (/^\s*DELETE/i.test(filled)) return execDelete(filled, tables);
    if (/^\s*SELECT/i.test(filled)) return execSelect(filled, tables);
    return { rows: [], rowCount: 0 };
  }

  var client = {
    query: function(sql, params){ return Promise.resolve(doQuery(sql, params || [])); },
    release: function(){}
  };

  return {
    query: function(sql, params){ return Promise.resolve(doQuery(sql, params || [])); },
    connect: function(){ return Promise.resolve(client); },
    end: function(){},
    _tables: tables,
    _counters: counters
  };
}

module.exports = { createMockPool: createMockPool, fillParams: fillParams, parseLiteral: parseLiteral, evalWhere: evalWhere, evalSetExpr: evalSetExpr };





