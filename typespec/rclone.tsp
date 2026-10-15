using TypeSpec.Http;
using TypeSpec.OpenAPI;
namespace TelDrive;
model RcloneActionRequest {
  method: string;
  params?: Record<unknown>;
}
@route("/v1/rclone")
@useAuth(BearerOrCookieAuth)
@tag("Rclone")
interface RcloneOperations {
  @post @route("/actions") @operationId("rcloneAction")
  action(@body body: RcloneActionRequest): JsonResponse<200, unknown> | ErrorResponse<401> | ErrorResponse<403> | ErrorResponse<409> | ErrorResponse<422> | ErrorResponse<502>;
  @put @route("/staging/{filename}") @operationId("rcloneStage")
  stage(@path filename: string, @header contentType: "application/octet-stream", @body body: bytes): JsonResponse<201, {path: string}> | ErrorResponse<401> | ErrorResponse<403> | ErrorResponse<413>;
  @get @route("/local-content") @operationId("rcloneLocalContent")
  content(@query path: string): {@statusCode statusCode: 200; @header contentType: "application/octet-stream"; @body body: bytes;} | ErrorResponse<401> | ErrorResponse<403>;
}
