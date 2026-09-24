using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GridSync.Api.Persistence.Migrations
{
    /// <summary>
    /// Cells were addressed by row number; now they are addressed by a stable row id, so that
    /// inserting a row does not change which cell an edit refers to. Every row a sheet started with
    /// is named "b" plus its number, so the existing log converts exactly and no edit is lost.
    ///
    /// Snapshots are deleted rather than converted: they are only a shortcut for restoring (the log
    /// is never truncated), and the sheet is rebuilt from the full log the next time it is opened.
    /// </summary>
    public partial class AddRowIds : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "RowId",
                table: "OpLog",
                type: "nvarchar(40)",
                maxLength: 40,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<string>(
                name: "RowKey",
                table: "OpLog",
                type: "nvarchar(64)",
                maxLength: 64,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "RowsJson",
                table: "Snapshots",
                type: "nvarchar(max)",
                nullable: false,
                defaultValue: "[]");

            migrationBuilder.Sql("UPDATE [OpLog] SET [RowId] = 'b' + CAST([Row] AS nvarchar(10));");
            migrationBuilder.Sql("DELETE FROM [Snapshots];");

            migrationBuilder.DropColumn(
                name: "Row",
                table: "OpLog");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "Row",
                table: "OpLog",
                type: "int",
                nullable: false,
                defaultValue: 0);

            // Rows that were inserted have no row number to go back to, so those entries are dropped.
            migrationBuilder.Sql("DELETE FROM [OpLog] WHERE [RowKey] IS NOT NULL OR [RowId] NOT LIKE 'b%';");
            migrationBuilder.Sql("UPDATE [OpLog] SET [Row] = CAST(SUBSTRING([RowId], 2, 10) AS int);");
            migrationBuilder.Sql("DELETE FROM [Snapshots];");

            migrationBuilder.DropColumn(
                name: "RowsJson",
                table: "Snapshots");

            migrationBuilder.DropColumn(
                name: "RowId",
                table: "OpLog");

            migrationBuilder.DropColumn(
                name: "RowKey",
                table: "OpLog");
        }
    }
}
