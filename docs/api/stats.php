<?php
// VOID CLIENT — telemetry dashboard (protected by ?token=).
$TOKEN = 'void2026'; // смените на свой
if (!isset($_GET['token']) || $_GET['token'] !== $TOKEN) {
    http_response_code(401);
    echo 'Forbidden';
    exit;
}
header('Content-Type: text/html; charset=utf-8');

$file = dirname(__DIR__) . '/telemetry.jsonl';
$agg_file = dirname(__DIR__) . '/telemetry_daily.json';

$total = 0;
$byVersion = array();
$byPlatform = array();
$byArch = array();
$unique = array();
$rows = array();

if (file_exists($file)) {
    $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines) {
        foreach ($lines as $line) {
            $e = json_decode((string)$line, true);
            if (!$e) continue;
            $total++;
            $v = isset($e['version']) ? $e['version'] : '?';
            $byVersion[$v] = (isset($byVersion[$v]) ? $byVersion[$v] : 0) + 1;
            $p = isset($e['platform']) ? $e['platform'] : '?';
            $byPlatform[$p] = (isset($byPlatform[$p]) ? $byPlatform[$p] : 0) + 1;
            $a = isset($e['arch']) ? $e['arch'] : '?';
            $byArch[$a] = (isset($byArch[$a]) ? $byArch[$a] : 0) + 1;
            $id = isset($e['install_id']) ? $e['install_id'] : '';
            $unique[$id] = true;
            $rows[] = $e;
        }
    }
}

$daily = array();
if (file_exists($agg_file)) {
    $tmp = json_decode(file_get_contents($agg_file), true);
    if (is_array($tmp)) $daily = $tmp;
}
arsort($daily);

function rows($label, $map) {
    echo '<tr><td>' . htmlspecialchars($label) . '</td><td>' . count($map) . '</td><td>';
    foreach ($map as $k => $v) echo htmlspecialchars($k) . ': ' . $v . ' &nbsp; ';
    echo '</td></tr>';
}
?>
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>VOID CLIENT — telemetry</title>
<style>
body{background:#050508;color:#d8d8d8;font:14px/1.6 'Segoe UI',sans-serif;margin:0;padding:32px}
h1{color:#fff;font-weight:600;letter-spacing:2px;font-size:22px}
table{border-collapse:collapse;margin-top:20px;width:100%;max-width:860px}
th,td{border:1px solid #26262e;padding:8px 12px;text-align:left}
th{color:#fff;background:#101018}
td{color:#c8c8c8}
.muted{color:#7a7a7a;font-size:12px}
</style>
</head>
<body>
<h1>VOID CLIENT — telemetry</h1>
<p class="muted">Anonymous: launcher version, OS, unique installs. One ping per day per install.</p>
<table>
<tr><th>Metric</th><th>Count</th><th>Details</th></tr>
<tr><td>Total pings</td><td><?php echo $total; ?></td><td></td></tr>
<tr><td>Unique installs</td><td><?php echo count($unique); ?></td><td></td></tr>
<?php rows('By version', $byVersion); ?>
<?php rows('By platform', $byPlatform); ?>
<?php rows('By arch', $byArch); ?>
</table>
<h1>Роллап по дням</h1>
<table>
<tr><th>Date</th><th>Pings</th></tr>
<?php foreach ($daily as $d => $n) echo "<tr><td>" . htmlspecialchars($d) . "</td><td>" . (int)$n . "</td></tr>"; ?>
</table>
<p class="muted">Последние записи:</p>
<pre style="border:1px solid #26262e;padding:12px;max-width:860px;overflow:auto"><?php
foreach (array_slice(array_reverse($rows), 0, 20) as $r) {
    echo json_encode($r), "\n";
}
?></pre>
</body>
</html>