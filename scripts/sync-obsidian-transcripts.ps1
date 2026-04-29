#Requires -Version 5.0
<#
.SYNOPSIS
    Syncs markdown files from network share to local Obsidian directory,
    categorizing into Transcript and Summary subfolders.

.DESCRIPTION
    This script copies markdown files from a network share to a local Obsidian
    directory. Files ending with " - Transcript.md" are placed in a "Transcript"
    subfolder, while all other files go into a "Summary" subfolder. The script
    maintains a JSON tracking file to prevent re-copying files that haven't changed.

.PARAMETER SourcePath
    The network source path containing markdown files.
    Required. No default value is set.

.PARAMETER DestinationPath
    The local destination base path for organized files.
    Required. No default value is set.

.PARAMETER TrackingFile
    Path to the JSON file tracking previously copied files.
    Required. No default value is set.

.PARAMETER DryRun
    If specified, shows what would be copied without actually copying.

.PARAMETER LogFile
    Optional path to log all operations. If not specified, logs only to console.

.EXAMPLE
    .\sync-obsidian-transcripts.ps1 -SourcePath "\\server\share\source" -DestinationPath "C:\path\to\destination" -TrackingFile "C:\path\to\.sync-tracking.json"
    Runs with required paths.

.EXAMPLE
    .\sync-obsidian-transcripts.ps1 -SourcePath "\\server\share\source" -DestinationPath "C:\path\to\destination" -TrackingFile "C:\path\to\.sync-tracking.json" -DryRun -LogFile "C:\logs\sync.log"
    Preview changes and log to file without copying.
#>

param(
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$SourcePath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$DestinationPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$TrackingFile,
    [switch]$DryRun,
    [string]$LogFile
)

# ============================================================================
# Initialize Script
# ============================================================================

$script:OperationLog = @()
$script:FilesProcessed = @{
    Success = 0
    Skipped = 0
    Failed = 0
}
$script:Errors = @()

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet("Info", "Warning", "Error")][string]$Level = "Info",
        [switch]$NoConsole
    )

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    
    $script:OperationLog += $logEntry
    
    if (-not $NoConsole) {
        switch ($Level) {
            "Info"    { Write-Host $logEntry }
            "Warning" { Write-Host $logEntry -ForegroundColor Yellow }
            "Error"   { Write-Host $logEntry -ForegroundColor Red }
        }
    }
}

function Write-LogFile {
    if ($LogFile) {
        try {
            $script:OperationLog | Out-File -FilePath $LogFile -Encoding UTF8 -Force
        } catch {
            Write-Log "Failed to write log file: $_" "Warning"
        }
    }
}

# ============================================================================
# Validation
# ============================================================================

Write-Log "Starting sync operation..."
Write-Log "Source: $SourcePath"
Write-Log "Destination: $DestinationPath"
Write-Log "Tracking file: $TrackingFile"
if ($DryRun) { Write-Log "DRY RUN MODE - No files will be copied" "Warning" }

# Validate source path
if (-not (Test-Path $SourcePath)) {
    Write-Log "Source path not accessible: $SourcePath" "Error"
    Write-LogFile
    exit 1
}

# Create destination if it doesn't exist
if (-not (Test-Path $DestinationPath)) {
    try {
        New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
        Write-Log "Created destination directory: $DestinationPath"
    } catch {
        Write-Log "Failed to create destination directory: $_" "Error"
        Write-LogFile
        exit 1
    }
}

# Create tracking directory if it doesn't exist
$trackingDir = Split-Path -Path $TrackingFile -Parent
if ($trackingDir -and -not (Test-Path $trackingDir)) {
    try {
        New-Item -ItemType Directory -Path $trackingDir -Force | Out-Null
        Write-Log "Created tracking file directory: $trackingDir"
    } catch {
        Write-Log "Failed to create tracking file directory: $_" "Error"
        Write-LogFile
        exit 1
    }
}

# ============================================================================
# Load/Initialize Tracking File
# ============================================================================

$tracking = @{
    version = "1.0"
    lastSync = (Get-Date).ToUniversalTime().ToString("o")
    files = @{}
}

if (Test-Path $TrackingFile) {
    try {
        $existingTracking = Get-Content $TrackingFile -Raw | ConvertFrom-Json
        $tracking.files = $existingTracking.files | ForEach-Object { $_ }
        Write-Log "Loaded tracking file with $($tracking.files.Count) previous entries"
    } catch {
        Write-Log "Failed to load tracking file, starting fresh: $_" "Warning"
    }
}

# Convert tracking.files to hashtable if it's PSCustomObject
if ($tracking.files -is [System.Management.Automation.PSCustomObject]) {
    $newFiles = @{}
    $tracking.files | Get-Member -MemberType NoteProperty | ForEach-Object {
        $newFiles[$_.Name] = $tracking.files.$($_.Name)
    }
    $tracking.files = $newFiles
}

# ============================================================================
# Discover and Categorize Files
# ============================================================================

Write-Log "Discovering markdown files..."

$filesToProcess = @()

Get-ChildItem -Path $SourcePath -Filter "*.md" -Recurse | ForEach-Object {
    $sourceFile = $_
    $relativePath = $sourceFile.FullName.Substring($SourcePath.Length).TrimStart('\')
    
    # Determine category based on filename
    if ($sourceFile.Name -match " - Transcript\.md$") {
        $category = "Transcript"
    } else {
        $category = "Summary"
    }
    
    # Build destination path
    $fileName = Split-Path -Path $relativePath -Leaf
    $parentPath = Split-Path -Path $relativePath -Parent
    
    if ($parentPath) {
        $destDir = Join-Path -Path $DestinationPath -ChildPath "$parentPath\$category"
    } else {
        $destDir = Join-Path -Path $DestinationPath -ChildPath $category
    }
    
    $destFilePath = Join-Path -Path $destDir -ChildPath $fileName
    
    $filesToProcess += @{
        SourceFile = $sourceFile.FullName
        DestFile = $destFilePath
        DestDir = $destDir
        RelativePath = $relativePath
        Category = $category
        Name = $sourceFile.Name
    }
}

Write-Log "Found $($filesToProcess.Count) markdown files"

# ============================================================================
# Process Files
# ============================================================================

foreach ($file in $filesToProcess) {
    try {
        # Calculate hash of source file
        $sourceHash = (Get-FileHash -Path $file.SourceFile -Algorithm SHA256).Hash
        
        # Check if file was already copied with same hash
        if ($tracking.files.ContainsKey($file.RelativePath)) {
            $trackedFile = $tracking.files[$file.RelativePath]
            if ($trackedFile.sourceHash -eq $sourceHash) {
                Write-Log "Skipping (unchanged): $($file.Name)" "Info"
                $script:FilesProcessed.Skipped++
                continue
            } else {
                Write-Log "Re-copying (changed): $($file.Name)" "Info"
            }
        } else {
            Write-Log "Copying (new): $($file.Name)" "Info"
        }
        
        # Create destination directory
        if (-not (Test-Path $file.DestDir)) {
            if ($DryRun) {
                Write-Log "  [DRY RUN] Would create directory: $($file.DestDir)"
            } else {
                New-Item -ItemType Directory -Path $file.DestDir -Force | Out-Null
                Write-Log "  Created directory: $($file.DestDir)"
            }
        }
        
        # Copy file
        if (-not $DryRun) {
            Copy-Item -Path $file.SourceFile -Destination $file.DestFile -Force
            Write-Log "  Copied to: $($file.DestFile)"
            
            # Update tracking
            $tracking.files[$file.RelativePath] = @{
                sourceHash = $sourceHash
                destPath = $file.DestFile
                category = $file.Category
                copiedAt = (Get-Date).ToUniversalTime().ToString("o")
            }
        } else {
            Write-Log "  [DRY RUN] Would copy to: $($file.DestFile)"
            Write-Log "  [DRY RUN] Category: $($file.Category)"
        }
        
        $script:FilesProcessed.Success++
        
    } catch {
        $errorMsg = "Failed to process $($file.Name): $_"
        Write-Log $errorMsg "Error"
        $script:Errors += $errorMsg
        $script:FilesProcessed.Failed++
    }
}

# ============================================================================
# Update Tracking File
# ============================================================================

if (-not $DryRun) {
    try {
        $tracking.lastSync = (Get-Date).ToUniversalTime().ToString("o")
        
        # Write to temp file first
        $tempTrackingFile = "$TrackingFile.tmp"
        $tracking | ConvertTo-Json -Depth 10 | Out-File -FilePath $tempTrackingFile -Encoding UTF8
        
        # Replace original with temp file
        Move-Item -Path $tempTrackingFile -Destination $TrackingFile -Force
        Write-Log "Updated tracking file"
    } catch {
        Write-Log "Failed to update tracking file: $_" "Error"
        $script:Errors += "Failed to update tracking file: $_"
    }
}

# ============================================================================
# Report Summary
# ============================================================================

Write-Log ""
Write-Log "========== SYNC COMPLETE ==========" "Info"
Write-Log "Files copied:  $($script:FilesProcessed.Success)"
Write-Log "Files skipped: $($script:FilesProcessed.Skipped)"
Write-Log "Files failed:  $($script:FilesProcessed.Failed)"

if ($script:Errors.Count -gt 0) {
    Write-Log "Errors encountered:" "Warning"
    $script:Errors | ForEach-Object {
        Write-Log "  - $_" "Error"
    }
}

Write-LogFile

if ($script:FilesProcessed.Failed -gt 0) {
    exit 1
}

exit 0
