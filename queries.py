"""按根数据集追溯来源的查询（递归 CTE），以及查看页面需要的图数据。"""


def trace_provenance(db, root_type, root_id, root_version):
    """从根数据集出发沿引用边递归追溯，返回 [(type,id,version,depth,path), ...]。

    path 记录从根到该节点的引用链（type:id:v 序列），并用它做循环保护，
    保证环上的节点只出现一次。
    """
    rows = db.conn.execute(
        """
        WITH RECURSIVE reach(type, id, version, depth, path) AS (
          SELECT ?, ?, ?, 0, ? || ':' || ? || ':' || ?
          UNION
          SELECT e.to_type, e.to_id, e.to_version, r.depth + 1,
                 r.path || '/' || e.to_type || ':' || e.to_id || ':' || e.to_version
          FROM edges e
          JOIN reach r ON e.from_type = r.type AND e.from_id = r.id
                      AND e.from_version = r.version
          WHERE instr(r.path, e.to_type || ':' || e.to_id || ':' || e.to_version) = 0
        )
        -- 同一节点可能经多条路径可达：按节点去重，取最短深度与一条代表路径
        SELECT type, id, version, MIN(depth) AS depth, MIN(path) AS path
        FROM reach GROUP BY type, id, version ORDER BY depth, id
        """,
        (root_type, root_id, root_version, root_type, root_id, root_version),
    ).fetchall()
    return [dict(r) for r in rows]


def graph_data(db):
    """查看页面用：全部对象、边、缺口、运行。"""
    objects = [dict(r) for r in db.conn.execute(
        "SELECT type,id,version,payload,fetched_run FROM objects ORDER BY type,id")]
    edges = [dict(r) for r in db.conn.execute(
        "SELECT * FROM edges ORDER BY from_id, to_id")]
    gaps = [dict(r) for r in db.conn.execute(
        "SELECT * FROM gaps ORDER BY gap_id")]
    runs = [dict(r) for r in db.conn.execute(
        "SELECT * FROM runs ORDER BY run_id")]
    roots = [dict(r) for r in db.conn.execute(
        "SELECT * FROM roots ORDER BY run_id")]
    return {"objects": objects, "edges": edges, "gaps": gaps,
            "runs": runs, "roots": roots}
