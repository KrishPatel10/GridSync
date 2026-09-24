using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace GridSync.Api.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "OpLog",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    SheetId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    Row = table.Column<int>(type: "int", nullable: false),
                    Col = table.Column<int>(type: "int", nullable: false),
                    Value = table.Column<string>(type: "nvarchar(max)", maxLength: 10000, nullable: true),
                    WallMs = table.Column<long>(type: "bigint", nullable: false),
                    Counter = table.Column<int>(type: "int", nullable: false),
                    NodeId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OpLog", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Snapshots",
                columns: table => new
                {
                    SheetId = table.Column<string>(type: "nvarchar(64)", maxLength: 64, nullable: false),
                    CellsJson = table.Column<string>(type: "nvarchar(max)", nullable: false),
                    UpToOpId = table.Column<long>(type: "bigint", nullable: false),
                    WrittenAtUtc = table.Column<DateTimeOffset>(type: "datetimeoffset", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Snapshots", x => x.SheetId);
                });

            migrationBuilder.CreateIndex(
                name: "IX_OpLog_SheetId_Id",
                table: "OpLog",
                columns: new[] { "SheetId", "Id" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "OpLog");

            migrationBuilder.DropTable(
                name: "Snapshots");
        }
    }
}
