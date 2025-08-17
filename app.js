require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア
app.use(express.json());
app.use(cors());

// 静的ファイル配信
app.use(express.static("public"));

// PostgreSQL接続設定
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: 20, // 最大接続数
  idleTimeoutMillis: 30000, // アイドルタイムアウト
  connectionTimeoutMillis: 2000, // 接続タイムアウト
});

// データベース接続確認
pool.on("connect", () => {
  console.log("Connected to PostgreSQL database");
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

// テーブル初期化（アプリ起動時に実行）
async function initDatabase() {
  try {
    const client = await pool.connect();

    // テーブル作成
    await client.query(`
      CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // インデックス作成
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_items_name ON items(name)
    `);

    client.release();
    console.log("Database tables and indexes initialized");
  } catch (err) {
    console.error("Database initialization error:", err);
  }
}

// 起動時にテーブル作成
initDatabase();

// ルート
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

app.get("/test", (req, res) => {
  res.send("Hello from EC2 with PostgreSQL!");
});

// データ保存API
app.post("/api/items", async (req, res) => {
  const client = await pool.connect();

  try {
    const { name, value } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    // トランザクション開始
    await client.query("BEGIN");

    const result = await client.query(
      "INSERT INTO items (name, value) VALUES ($1, $2) RETURNING *",
      [name, value]
    );

    // トランザクションコミット
    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    // トランザクションロールバック
    await client.query("ROLLBACK");
    console.error("Error saving item:", error);
    res.status(500).json({
      success: false,
      error: "Failed to save item",
      details: error.message,
    });
  } finally {
    client.release();
  }
});

// データ取得API（ページネーション対応）
app.get("/api/items", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // 総件数取得
    const countResult = await pool.query("SELECT COUNT(*) FROM items");
    const totalItems = parseInt(countResult.rows[0].count);

    // データ取得
    const result = await pool.query(
      "SELECT * FROM items ORDER BY created_at DESC LIMIT $1 OFFSET $2",
      [limit, offset]
    );

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching items:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch items",
      details: error.message,
    });
  }
});

// 検索API
app.get("/api/items/search", async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: "Search query is required" });
    }

    const result = await pool.query(
      "SELECT * FROM items WHERE name ILIKE $1 OR value ILIKE $1 ORDER BY created_at DESC",
      [`%${q}%`]
    );

    res.json({
      success: true,
      data: result.rows,
      searchQuery: q,
    });
  } catch (error) {
    console.error("Error searching items:", error);
    res.status(500).json({
      success: false,
      error: "Failed to search items",
      details: error.message,
    });
  }
});

// 特定データ取得API
app.get("/api/items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }

    const result = await pool.query("SELECT * FROM items WHERE id = $1", [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Item not found",
      });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Error fetching item:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch item",
      details: error.message,
    });
  }
});

// データ更新API
app.put("/api/items/:id", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const { name, value } = req.body;

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    await client.query("BEGIN");

    const result = await client.query(
      "UPDATE items SET name = $1, value = $2 WHERE id = $3 RETURNING *",
      [name, value, id]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: "Item not found",
      });
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error updating item:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update item",
      details: error.message,
    });
  } finally {
    client.release();
  }
});

// データ削除API
app.delete("/api/items/:id", async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid ID format" });
    }

    await client.query("BEGIN");

    const result = await client.query(
      "DELETE FROM items WHERE id = $1 RETURNING *",
      [id]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: "Item not found",
      });
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Item deleted successfully",
      deletedItem: result.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting item:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete item",
      details: error.message,
    });
  } finally {
    client.release();
  }
});

// バッチ削除API
app.delete("/api/items", async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query("DELETE FROM items RETURNING COUNT(*)");

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "All items deleted successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error clearing items:", error);
    res.status(500).json({
      success: false,
      error: "Failed to clear items",
      details: error.message,
    });
  } finally {
    client.release();
  }
});

// 統計API
app.get("/api/stats", async (req, res) => {
  try {
    const results = await Promise.all([
      pool.query("SELECT COUNT(*) as total_items FROM items"),
      pool.query("SELECT COUNT(DISTINCT name) as unique_names FROM items"),
      pool.query(
        "SELECT MIN(created_at) as first_item, MAX(created_at) as last_item FROM items"
      ),
    ]);

    res.json({
      success: true,
      data: {
        totalItems: parseInt(results[0].rows[0].total_items),
        uniqueNames: parseInt(results[1].rows[0].unique_names),
        firstItem: results[2].rows[0].first_item,
        lastItem: results[2].rows[0].last_item,
      },
    });
  } catch (error) {
    console.error("Error fetching stats:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch statistics",
      details: error.message,
    });
  }
});

// ヘルスチェック（詳細版）
app.get("/health", async (req, res) => {
  try {
    const start = Date.now();

    // 接続テスト
    const result = await pool.query(
      "SELECT NOW() as server_time, version() as pg_version"
    );
    const connectionTime = Date.now() - start;

    // 統計取得
    const stats = await pool.query("SELECT COUNT(*) as item_count FROM items");

    res.json({
      status: "OK",
      database: "Connected (PostgreSQL)",
      serverTime: result.rows[0].server_time,
      postgresVersion:
        result.rows[0].pg_version.split(" ")[0] +
        " " +
        result.rows[0].pg_version.split(" ")[1],
      connectionTime: `${connectionTime}ms`,
      totalItems: parseInt(stats.rows[0].item_count),
      poolStatus: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: "Error",
      database: "Disconnected",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// グレースフルシャットダウン
process.on("SIGINT", async () => {
  console.log("Shutting down gracefully...");
  await pool.end();
  console.log("Database pool closed.");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down gracefully...");
  await pool.end();
  console.log("Database pool closed.");
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(
    `Database: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`
  );
});
