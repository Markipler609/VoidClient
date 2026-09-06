<?php
// VOID CLIENT — returns the download counter as JSON.
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
$f = __DIR__ . '/download_stats.json';
$n = 0;
if (file_exists($f)) {
    $s = json_decode(file_get_contents($f), true);
    if (is_array($s) && isset($s['downloads'])) $n = (int)$s['downloads'];
}
echo json_encode(array('downloads' => $n));
?>