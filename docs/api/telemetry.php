<?php
// VOID CLIENT — anonymous telemetry collector.
// Accepts POST JSON/Form: install_id, version, platform, arch, date.
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

$data = null;
$raw = file_get_contents('php://input');
if ($raw) $data = json_decode($raw, true);
if (!$data) $data = $_POST;
if (!$data) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'no payload']);
    exit;
}

$entry = [
    'ts' => date('c'),
    'install_id' => substr((string)($data['install_id'] ?? ''), 0, 64),
    'version'    => substr((string)($data['version'] ?? ''), 0, 32),
    'platform'   => substr((string)($data['platform'] ?? ''), 0, 16),
    'arch'       => substr((string)($data['arch'] ?? ''), 0, 16),
    'date'       => substr((string)($data['date'] ?? date('Y-m-d')), 0, 10),
];

$file = dirname(__DIR__) . '/telemetry.jsonl';

// Keep the log bounded: keep the last 5000 lines
if (file_exists($file)) {
    $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (count($lines) > 5000) {
        $out = implode("\n", array_slice($lines, -5000)) . "\n";
        file_put_contents($file, $out, LOCK_EX);
    }
}

$fp = fopen($file, 'a');
if ($fp) {
    flock($fp, LOCK_EX);
    fwrite($fp, json_encode($entry, JSON_UNESCAPED_SLASHES) . "\n");
    flock($fp, LOCK_UN);
    fclose($fp);
}

// Daily rollup for the dashboard
$agg_file = dirname(__DIR__) . '/telemetry_daily.json';
$agg = [];
if (file_exists($agg_file)) $agg = json_decode(file_get_contents($agg_file), true);
$day = $entry['date'];
$agg[$day] = ($agg[$day] ?? 0) + 1;
file_put_contents($agg_file, json_encode($agg), LOCK_EX);

echo json_encode(['ok' => true]);
?>