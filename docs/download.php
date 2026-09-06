<?php
// VOID CLIENT — фаллбэк на старый файл, пока не загружен VOID_Launcher.exe
$file = 'VOID_Launcher.exe';
if (!file_exists($file)) {
    $file = 'HappyFriends_Launcher.exe';
}

if (file_exists($file)) {
    // Считаем скачивания
    $stats_file = 'download_stats.json';
    $stats = array();
    if (file_exists($stats_file)) {
        $tmp = json_decode(file_get_contents($stats_file), true);
        if (is_array($tmp)) $stats = $tmp;
    }
    $stats['downloads'] = (isset($stats['downloads']) ? (int)$stats['downloads'] : 0) + 1;
    $stats['by_file'][$file] = (isset($stats['by_file'][$file]) ? (int)$stats['by_file'][$file] : 0) + 1;
    file_put_contents($stats_file, json_encode($stats), LOCK_EX);

    // Отправляем файл
    header('Content-Description: File Transfer');
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . basename($file) . '"');
    header('Expires: 0');
    header('Cache-Control: must-revalidate');
    header('Pragma: public');
    header('Content-Length: ' . filesize($file));
    readfile($file);
    exit;
} else {
    http_response_code(404);
    echo "Файл не найден";
}
?>